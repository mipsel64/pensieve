use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use async_trait::async_trait;
use rusqlite::{Connection, OptionalExtension, Row, params};

use super::{Edge, Graph, Hit, Link, Node, Page, Storage};
use crate::error::{Error, Result};

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL UNIQUE COLLATE NOCASE,
    content TEXT NOT NULL,
    rev INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_by TEXT NOT NULL
);

-- Every version ever written, including the current one.
CREATE TABLE IF NOT EXISTS revisions (
    title TEXT NOT NULL COLLATE NOCASE,
    rev INTEGER NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    PRIMARY KEY (title, rev)
);

-- dst is a title, not an id, so links to pages that don't exist yet are kept.
CREATE TABLE IF NOT EXISTS links (
    src INTEGER NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
    dst TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (src, dst)
);
CREATE INDEX IF NOT EXISTS links_dst ON links (dst);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5 (
    title, content, content = 'pages', content_rowid = 'id', tokenize = 'porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
    INSERT INTO pages_fts (rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
    INSERT INTO pages_fts (pages_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
    INSERT INTO pages_fts (pages_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
    INSERT INTO pages_fts (rowid, title, content) VALUES (new.id, new.title, new.content);
END;
"#;

/// Characters of page content handed to rerankers per hit.
const EXCERPT_CHARS: i64 = 3000;

/// SQLite with FTS5 BM25 search.
// ponytail: one connection behind a global lock; a connection pool if write volume ever matters.
pub struct SqliteStorage {
    conn: Arc<Mutex<Connection>>,
}

impl SqliteStorage {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    // rusqlite blocks, so queries run on tokio's blocking pool instead of a runtime worker.
    async fn run<T, F>(&self, query: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    {
        let conn = Arc::clone(&self.conn);
        tokio::task::spawn_blocking(move || {
            query(&mut conn.lock().unwrap_or_else(PoisonError::into_inner))
        })
        .await
        .map_err(Error::storage)?
    }
}

#[async_trait]
impl Storage for SqliteStorage {
    async fn page(&self, title: &str) -> Result<Page> {
        let title = title.to_owned();
        self.run(move |conn| page(conn, &title)).await
    }

    async fn save(
        &self,
        title: &str,
        content: &str,
        links: &[&str],
        base_rev: Option<i64>,
        author: &str,
    ) -> Result<i64> {
        let (title, content, author) = (title.to_owned(), content.to_owned(), author.to_owned());
        let links: Vec<_> = links.iter().map(|link| (*link).to_owned()).collect();
        self.run(move |conn| save(conn, &title, &content, &links, base_rev, &author))
            .await
    }

    async fn search(&self, query: &str, limit: usize) -> Result<Vec<Hit>> {
        let query = query.to_owned();
        self.run(move |conn| search(conn, &query, limit)).await
    }

    async fn graph(&self) -> Result<Graph> {
        self.run(|conn| graph(conn)).await
    }

    async fn pages(&self) -> Result<Vec<(String, String)>> {
        self.run(|conn| pages(conn)).await
    }
}

impl From<rusqlite::Error> for Error {
    fn from(source: rusqlite::Error) -> Self {
        Self::storage(source)
    }
}

fn page(conn: &Connection, title: &str) -> Result<Page> {
    let (id, title, content, rev, updated_at, updated_by) = conn
        .query_row(
            "SELECT id, title, content, rev, updated_at, updated_by FROM pages WHERE title = ?1",
            [title],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .optional()?
        .ok_or(Error::NotFound)?;
    let links = conn
        .prepare_cached(
            "SELECT COALESCE(d.title, l.dst), d.id IS NOT NULL
             FROM links l LEFT JOIN pages d ON d.title = l.dst
             WHERE l.src = ?1 ORDER BY 1",
        )?
        .query_map([id], |r| {
            Ok(Link {
                title: r.get(0)?,
                exists: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let backlinks = conn
        .prepare_cached(
            "SELECT s.title FROM links l JOIN pages s ON s.id = l.src
             WHERE l.dst = ?1 AND s.id != ?2 ORDER BY 1",
        )?
        .query_map(params![title, id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Page {
        title,
        content,
        rev,
        updated_at,
        updated_by,
        links,
        backlinks,
    })
}

fn save(
    conn: &mut Connection,
    title: &str,
    content: &str,
    links: &[String],
    base_rev: Option<i64>,
    author: &str,
) -> Result<i64> {
    let tx = conn.transaction()?;
    let current = tx
        .query_row(
            "SELECT rev, content FROM pages WHERE title = ?1",
            [title],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?;
    let rev = current.as_ref().map_or(0, |(rev, _)| *rev);
    if base_rev.is_some_and(|base| base != rev) {
        return Err(Error::Conflict { rev });
    }
    if current.is_some_and(|(_, old)| old == content) {
        return Ok(rev);
    }
    let rev = rev + 1;
    let id: i64 = tx.query_row(
        "INSERT INTO pages (title, content, rev, updated_by) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (title) DO UPDATE SET content = excluded.content, rev = excluded.rev,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by
         RETURNING id",
        params![title, content, rev, author],
        |r| r.get(0),
    )?;
    tx.execute(
        "INSERT INTO revisions (title, rev, content, updated_at, updated_by)
         SELECT title, rev, content, updated_at, updated_by FROM pages WHERE id = ?1",
        [id],
    )?;
    tx.execute("DELETE FROM links WHERE src = ?1", [id])?;
    {
        let mut insert = tx.prepare("INSERT OR IGNORE INTO links (src, dst) VALUES (?1, ?2)")?;
        for link in links {
            insert.execute(params![id, link])?;
        }
    }
    tx.commit()?;
    Ok(rev)
}

fn search(conn: &Connection, query: &str, limit: usize) -> Result<Vec<Hit>> {
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    let Some(query) = fts_query(query) else {
        return conn
            .prepare_cached(
                "SELECT p.title, p.rev, p.updated_at, substr(p.content, 1, 200), 0.0, ''
                 FROM pages p JOIN revisions r ON r.title = p.title AND r.rev = p.rev
                 ORDER BY r.rowid DESC LIMIT ?1",
            )?
            .query_map([limit], hit)?
            .collect::<rusqlite::Result<_>>()
            .map_err(Into::into);
    };
    conn.prepare_cached(
        "SELECT p.title, p.rev, p.updated_at, snippet(pages_fts, 1, '«', '»', '…', 24),
                -bm25(pages_fts, 10.0, 1.0), substr(p.content, 1, ?3)
         FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid
         WHERE pages_fts MATCH ?1 ORDER BY 5 DESC LIMIT ?2",
    )?
    .query_map(params![query, limit, EXCERPT_CHARS], hit)?
    .collect::<rusqlite::Result<_>>()
    .map_err(Into::into)
}

fn graph(conn: &Connection) -> Result<Graph> {
    let mut nodes: Vec<_> = conn
        .prepare_cached("SELECT title FROM pages ORDER BY title")?
        .query_map([], |r| {
            Ok(Node {
                id: r.get(0)?,
                missing: false,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let edges: Vec<(Edge, bool)> = conn
        .prepare_cached(
            "SELECT s.title, COALESCE(d.title, l.dst), d.id IS NULL
             FROM links l JOIN pages s ON s.id = l.src LEFT JOIN pages d ON d.title = l.dst",
        )?
        .query_map([], |r| {
            Ok((
                Edge {
                    source: r.get(0)?,
                    target: r.get(1)?,
                },
                r.get(2)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    // Links to missing pages may differ in case; give each missing page one node id.
    let mut missing = BTreeMap::new();
    let links = edges
        .into_iter()
        .map(|(mut edge, is_missing)| {
            if is_missing {
                let id = missing
                    .entry(edge.target.to_lowercase())
                    .or_insert_with(|| edge.target.clone());
                edge.target.clone_from(id);
            }
            edge
        })
        .collect();
    nodes.extend(missing.into_values().map(|id| Node { id, missing: true }));
    Ok(Graph { nodes, links })
}

fn pages(conn: &Connection) -> Result<Vec<(String, String)>> {
    conn.prepare_cached("SELECT title, content FROM pages ORDER BY title")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()
        .map_err(Into::into)
}

fn hit(r: &Row) -> rusqlite::Result<Hit> {
    Ok(Hit {
        title: r.get(0)?,
        rev: r.get(1)?,
        updated_at: r.get(2)?,
        snippet: r.get(3)?,
        score: r.get(4)?,
        excerpt: r.get(5)?,
    })
}

/// Any-term match: quoting each token keeps user input out of FTS5 query syntax.
fn fts_query(query: &str) -> Option<String> {
    let terms: Vec<_> = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\""))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" OR "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn conformance_and_revisions() {
        let storage = SqliteStorage::open(Path::new(":memory:")).unwrap();
        crate::storage::conformance::check(&storage).await;

        let conn = storage.conn.lock().unwrap();
        let revisions: i64 = conn
            .query_row("SELECT count(*) FROM revisions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(revisions, 3);
    }
}
