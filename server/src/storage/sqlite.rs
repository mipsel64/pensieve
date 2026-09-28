use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use async_trait::async_trait;
use rusqlite::{Connection, OptionalExtension, Row, params};

use super::{
    Author, Count, Draft, Edge, Graph, HistoryFilter, Hit, Link, Node, Page, Passage, Revision,
    Stale, Stats, Storage, Visit,
};
use crate::{
    error::{Error, Result},
    markdown::{self, KINDS, Section},
};

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

-- Kept out of pages so recording a read doesn't fire the FTS update trigger.
CREATE TABLE IF NOT EXISTS visits (
    page INTEGER PRIMARY KEY REFERENCES pages (id) ON DELETE CASCADE,
    at TEXT NOT NULL
);

-- Pages split at ##/### headings, for passage retrieval.
CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY,
    page INTEGER NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    title TEXT NOT NULL,
    heading TEXT NOT NULL,
    body TEXT NOT NULL,
    UNIQUE (page, ord)
);

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

CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5 (
    title, heading, body, content = 'sections', content_rowid = 'id', tokenize = 'porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS sections_ai AFTER INSERT ON sections BEGIN
    INSERT INTO sections_fts (rowid, title, heading, body) VALUES (new.id, new.title, new.heading, new.body);
END;
CREATE TRIGGER IF NOT EXISTS sections_ad AFTER DELETE ON sections BEGIN
    INSERT INTO sections_fts (sections_fts, rowid, title, heading, body) VALUES ('delete', old.id, old.title, old.heading, old.body);
END;
"#;

/// Applied in order on top of `SCHEMA`; `PRAGMA user_version` counts how many ran.
/// Every migration is followed by a full reindex of derived data, so an empty entry is how to
/// reindex existing databases after changing how pages are parsed.
const MIGRATIONS: &[&str] = &["ALTER TABLE pages ADD COLUMN type TEXT;
     ALTER TABLE pages ADD COLUMN confidence TEXT;
     ALTER TABLE revisions ADD COLUMN summary TEXT;"];

/// Characters of page content handed to rerankers per hit.
const EXCERPT_CHARS: i64 = 3000;

/// SQLite with FTS5 BM25 search over pages and sections.
// ponytail: one connection behind a global lock; a connection pool if write volume ever matters.
pub struct SqliteStorage {
    conn: Arc<Mutex<Connection>>,
}

impl SqliteStorage {
    pub fn open(path: &Path) -> Result<Self> {
        let mut conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA)?;
        migrate(&mut conn)?;
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

    async fn save(&self, draft: Draft) -> Result<i64> {
        self.run(move |conn| save(conn, &draft)).await
    }

    async fn search(&self, query: &str, limit: usize) -> Result<Vec<Hit>> {
        let query = query.to_owned();
        self.run(move |conn| search(conn, &query, limit)).await
    }

    async fn search_sections(&self, terms: &[String], limit: usize) -> Result<Vec<Passage>> {
        let terms = terms.to_vec();
        self.run(move |conn| search_sections(conn, &terms, limit))
            .await
    }

    async fn visit(&self, title: &str) -> Result<()> {
        let title = title.to_owned();
        self.run(move |conn| visit(conn, &title)).await
    }

    async fn graph(&self) -> Result<Graph> {
        self.run(|conn| graph(conn)).await
    }

    async fn history(&self, filter: &HistoryFilter, limit: usize) -> Result<Vec<Revision>> {
        let filter = filter.clone();
        self.run(move |conn| history(conn, &filter, limit)).await
    }

    async fn stats(&self) -> Result<Stats> {
        self.run(|conn| stats(conn)).await
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

fn migrate(conn: &mut Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let pending = MIGRATIONS
        .get(usize::try_from(version).unwrap_or(usize::MAX)..)
        .unwrap_or_default();
    if pending.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    for migration in pending {
        tx.execute_batch(migration)?;
    }
    // Rebuild everything derived from content, so older pages gain new index data.
    let pages: Vec<(i64, String, String)> = tx
        .prepare("SELECT id, title, content FROM pages")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (id, title, content) in pages {
        let kind = markdown::field(&content, "type").filter(|kind| KINDS.contains(&kind.as_str()));
        let confidence = markdown::field(&content, "confidence");
        tx.execute(
            "UPDATE pages SET type = ?2, confidence = ?3 WHERE id = ?1",
            params![id, kind, confidence],
        )?;
        replace_links(&tx, id, &markdown::wikilinks(&content))?;
        replace_sections(&tx, id, &title, &markdown::sections(&content))?;
    }
    tx.pragma_update(None, "user_version", MIGRATIONS.len() as i64)?;
    tx.commit()?;
    Ok(())
}

fn replace_links(conn: &Connection, page: i64, links: &[String]) -> Result<()> {
    conn.execute("DELETE FROM links WHERE src = ?1", [page])?;
    let mut insert =
        conn.prepare_cached("INSERT OR IGNORE INTO links (src, dst) VALUES (?1, ?2)")?;
    for link in links {
        insert.execute(params![page, link])?;
    }
    Ok(())
}

fn replace_sections(conn: &Connection, page: i64, title: &str, sections: &[Section]) -> Result<()> {
    conn.execute("DELETE FROM sections WHERE page = ?1", [page])?;
    let mut insert = conn.prepare_cached(
        "INSERT INTO sections (page, ord, title, heading, body) VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for (ord, section) in (0_i64..).zip(sections) {
        insert.execute(params![page, ord, title, section.heading, section.body])?;
    }
    Ok(())
}

fn page(conn: &Connection, title: &str) -> Result<Page> {
    let row = conn
        .query_row(
            "SELECT p.id, p.title, p.content, p.rev, p.type, p.confidence, p.updated_at, p.updated_by, v.at
             FROM pages p LEFT JOIN visits v ON v.page = p.id WHERE p.title = ?1",
            [title],
            |r| {
                let page = Page {
                    title: r.get(1)?,
                    content: r.get(2)?,
                    rev: r.get(3)?,
                    kind: r.get(4)?,
                    confidence: r.get(5)?,
                    updated_at: r.get(6)?,
                    updated_by: r.get(7)?,
                    visited_at: r.get(8)?,
                    links: Vec::new(),
                    backlinks: Vec::new(),
                };
                Ok((r.get::<_, i64>(0)?, page))
            },
        )
        .optional()?;
    let (id, mut page) = row.ok_or(Error::NotFound)?;
    page.links = conn
        .prepare_cached(
            "SELECT COALESCE(d.title, l.dst), d.id IS NOT NULL, d.type
             FROM links l LEFT JOIN pages d ON d.title = l.dst
             WHERE l.src = ?1 ORDER BY 1",
        )?
        .query_map([id], |r| {
            Ok(Link {
                title: r.get(0)?,
                exists: r.get(1)?,
                kind: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    page.backlinks = conn
        .prepare_cached(
            "SELECT s.title FROM links l JOIN pages s ON s.id = l.src
             WHERE l.dst = ?1 AND s.id != ?2 ORDER BY 1",
        )?
        .query_map(params![page.title, id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(page)
}

fn save(conn: &mut Connection, draft: &Draft) -> Result<i64> {
    let tx = conn.transaction()?;
    let current = tx
        .query_row(
            "SELECT rev, content FROM pages WHERE title = ?1",
            [&draft.title],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?;
    let rev = current.as_ref().map_or(0, |(rev, _)| *rev);
    if draft.base_rev.is_some_and(|base| base != rev) {
        return Err(Error::Conflict { rev });
    }
    if current.is_some_and(|(_, old)| old == draft.content) {
        return Ok(rev);
    }
    let rev = rev + 1;
    let id: i64 = tx.query_row(
        "INSERT INTO pages (title, content, rev, updated_by, type, confidence) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (title) DO UPDATE SET content = excluded.content, rev = excluded.rev,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by,
             type = excluded.type, confidence = excluded.confidence
         RETURNING id",
        params![draft.title, draft.content, rev, draft.author, draft.kind, draft.confidence],
        |r| r.get(0),
    )?;
    tx.execute(
        "INSERT INTO revisions (title, rev, content, updated_at, updated_by, summary)
         SELECT title, rev, content, updated_at, updated_by, ?2 FROM pages WHERE id = ?1",
        params![id, draft.summary],
    )?;
    replace_links(&tx, id, &draft.links)?;
    let title: String =
        tx.query_row("SELECT title FROM pages WHERE id = ?1", [id], |r| r.get(0))?;
    replace_sections(&tx, id, &title, &draft.sections)?;
    tx.commit()?;
    Ok(rev)
}

fn search(conn: &Connection, query: &str, limit: usize) -> Result<Vec<Hit>> {
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    let words: Vec<_> = query
        .split(|c: char| !c.is_alphanumeric())
        .map(str::to_owned)
        .collect();
    let Some(query) = fts_query(&words) else {
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
        "SELECT p.title, p.rev, p.updated_at, snippet(pages_fts, -1, '«', '»', '…', 24),
                -bm25(pages_fts, 10.0, 1.0), substr(p.content, 1, ?3)
         FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid
         WHERE pages_fts MATCH ?1 ORDER BY 5 DESC LIMIT ?2",
    )?
    .query_map(params![query, limit, EXCERPT_CHARS], hit)?
    .collect::<rusqlite::Result<_>>()
    .map_err(Into::into)
}

fn search_sections(conn: &Connection, terms: &[String], limit: usize) -> Result<Vec<Passage>> {
    let Some(query) = fts_query(terms) else {
        return Ok(Vec::new());
    };
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    conn.prepare_cached(
        "SELECT p.title, s.heading, s.ord, s.body, p.rev, p.updated_at, p.type, p.confidence,
                -bm25(sections_fts, 5.0, 3.0, 1.0)
         FROM sections_fts JOIN sections s ON s.id = sections_fts.rowid JOIN pages p ON p.id = s.page
         WHERE sections_fts MATCH ?1 ORDER BY 9 DESC LIMIT ?2",
    )?
    .query_map(params![query, limit], |r| {
        Ok(Passage {
            title: r.get(0)?,
            heading: r.get(1)?,
            ord: r.get(2)?,
            text: r.get(3)?,
            rev: r.get(4)?,
            updated_at: r.get(5)?,
            kind: r.get(6)?,
            confidence: r.get(7)?,
            score: r.get(8)?,
        })
    })?
    .collect::<rusqlite::Result<_>>()
    .map_err(Into::into)
}

fn visit(conn: &Connection, title: &str) -> Result<()> {
    let recorded = conn.execute(
        "INSERT INTO visits (page, at)
         SELECT id, strftime('%Y-%m-%dT%H:%M:%SZ', 'now') FROM pages WHERE title = ?1
         ON CONFLICT (page) DO UPDATE SET at = excluded.at",
        [title],
    )?;
    if recorded == 0 {
        return Err(Error::NotFound);
    }
    Ok(())
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
                    .entry(edge.target.to_ascii_lowercase())
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

fn history(conn: &Connection, filter: &HistoryFilter, limit: usize) -> Result<Vec<Revision>> {
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    conn.prepare_cached(
        "SELECT rowid, title, rev, updated_at, updated_by, summary, length(CAST(content AS BLOB)) FROM revisions
         WHERE (?1 IS NULL OR title = ?1) AND (?2 IS NULL OR updated_by = ?2) AND (?3 IS NULL OR rowid < ?3)
         ORDER BY rowid DESC LIMIT ?4",
    )?
    .query_map(params![filter.title, filter.author, filter.before, limit], |r| {
        Ok(Revision {
            seq: r.get(0)?,
            title: r.get(1)?,
            rev: r.get(2)?,
            at: r.get(3)?,
            by: r.get(4)?,
            summary: r.get(5)?,
            bytes: r.get(6)?,
        })
    })?
    .collect::<rusqlite::Result<_>>()
    .map_err(Into::into)
}

const MISSING: &str =
    "FROM links l LEFT JOIN pages d ON d.title = l.dst WHERE d.id IS NULL GROUP BY l.dst";
const ORPHANS: &str =
    "FROM pages p WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.dst = p.title AND l.src != p.id)";

fn stats(conn: &Connection) -> Result<Stats> {
    let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0));
    let counts = |sql: &str| -> rusqlite::Result<Vec<Count>> {
        conn.prepare_cached(sql)?
            .query_map([], |r| {
                Ok(Count {
                    name: r.get(0)?,
                    count: r.get(1)?,
                })
            })?
            .collect()
    };
    let orphans = conn
        .prepare_cached(&format!(
            "SELECT p.title {ORPHANS} ORDER BY p.title LIMIT 10"
        ))?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let authors = conn
        .prepare_cached(
            "SELECT updated_by, count(*), count(DISTINCT title), max(updated_at) FROM revisions
             GROUP BY updated_by ORDER BY 4 DESC LIMIT 20",
        )?
        .query_map([], |r| {
            Ok(Author {
                name: r.get(0)?,
                writes: r.get(1)?,
                pages: r.get(2)?,
                last_at: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let recent_visits = conn
        .prepare_cached("SELECT p.title, v.at FROM visits v JOIN pages p ON p.id = v.page ORDER BY v.at DESC LIMIT 10")?
        .query_map([], |r| Ok(Visit { title: r.get(0)?, at: r.get(1)? }))?
        .collect::<rusqlite::Result<_>>()?;
    let stale = conn
        .prepare_cached(
            "SELECT p.title, p.updated_at, v.at FROM pages p LEFT JOIN visits v ON v.page = p.id
             ORDER BY max(p.updated_at, COALESCE(v.at, '')), p.title LIMIT 10",
        )?
        .query_map([], |r| {
            Ok(Stale {
                title: r.get(0)?,
                updated_at: r.get(1)?,
                visited_at: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Stats {
        pages: count("SELECT count(*) FROM pages")?,
        links: count("SELECT count(*) FROM links")?,
        revisions: count("SELECT count(*) FROM revisions")?,
        never_visited: count(
            "SELECT count(*) FROM pages p WHERE NOT EXISTS (SELECT 1 FROM visits v WHERE v.page = p.id)",
        )?,
        kinds: counts(
            "SELECT COALESCE(type, 'untyped'), count(*) FROM pages GROUP BY 1 ORDER BY 2 DESC, 1",
        )?,
        missing: counts(&format!(
            "SELECT l.dst, count(*) {MISSING} ORDER BY 2 DESC, 1 LIMIT 10"
        ))?,
        missing_total: count(&format!("SELECT count(*) FROM (SELECT 1 {MISSING})"))?,
        orphans,
        orphans_total: count(&format!("SELECT count(*) {ORPHANS}"))?,
        hubs: counts(
            "SELECT d.title, count(*) FROM links l JOIN pages d ON d.title = l.dst
             WHERE l.src != d.id GROUP BY d.id ORDER BY 2 DESC, 1 LIMIT 10",
        )?,
        authors,
        days: counts(
            "SELECT substr(updated_at, 1, 10), count(*) FROM revisions
             WHERE updated_at >= strftime('%Y-%m-%d', 'now', '-371 days') GROUP BY 1 ORDER BY 1",
        )?,
        recent_visits,
        stale,
    })
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

/// Any-term match; each term's words become one quoted phrase, which keeps input out of FTS5 syntax.
fn fts_query(terms: &[String]) -> Option<String> {
    let phrases: Vec<_> = terms
        .iter()
        .map(|term| {
            term.split(|c: char| !c.is_alphanumeric())
                .filter(|w| !w.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|words| !words.is_empty())
        .map(|words| format!("\"{}\"", words.join(" ")))
        .collect();
    (!phrases.is_empty()).then(|| phrases.join(" OR "))
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
        assert!(revisions >= 3);
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
    }
}
