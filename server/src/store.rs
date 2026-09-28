use std::{collections::BTreeMap, path::Path, time::Duration};

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;

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

/// Characters of page content sent to Jev per candidate.
const EXCERPT_CHARS: i64 = 3000;

#[derive(Debug)]
pub enum Error {
    NotFound,
    Conflict(i64),
    Invalid(&'static str),
    Db(rusqlite::Error),
}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Self::Db(error)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Serialize, Clone, Debug)]
pub struct Hit {
    pub title: String,
    pub rev: i64,
    pub updated_at: String,
    pub snippet: String,
    pub score: f64,
    #[serde(skip)]
    pub excerpt: String,
}

#[derive(Serialize)]
pub struct Page {
    pub title: String,
    pub content: String,
    pub rev: i64,
    pub updated_at: String,
    pub updated_by: String,
    pub links: Vec<Link>,
    pub backlinks: Vec<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Link {
    pub title: String,
    pub exists: bool,
}

#[derive(Serialize)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub links: Vec<Edge>,
}

#[derive(Serialize)]
pub struct Node {
    pub id: String,
    pub missing: bool,
}

#[derive(Serialize)]
pub struct Edge {
    pub source: String,
    pub target: String,
}

pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn })
    }

    pub fn page(&self, title: &str) -> Result<Page> {
        let (id, title, content, rev, updated_at, updated_by) = self
            .conn
            .query_row(
                "SELECT id, title, content, rev, updated_at, updated_by FROM pages WHERE title = ?1",
                [title],
                |r| Ok((r.get::<_, i64>(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        let links = self
            .conn
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
        let backlinks = self
            .conn
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

    /// `base_rev` must equal the current rev (0 = page must not exist); `None` skips the check.
    pub fn put(
        &mut self,
        title: &str,
        content: &str,
        base_rev: Option<i64>,
        by: &str,
    ) -> Result<i64> {
        let title = valid_title(title)?;
        if content.trim().is_empty() {
            return Err(Error::Invalid("content is empty"));
        }
        let tx = self.conn.transaction()?;
        let current = tx
            .query_row(
                "SELECT rev, content FROM pages WHERE title = ?1",
                [title],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?;
        let rev = current.as_ref().map_or(0, |(rev, _)| *rev);
        if base_rev.is_some_and(|base| base != rev) {
            return Err(Error::Conflict(rev));
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
            params![title, content, rev, by],
            |r| r.get(0),
        )?;
        tx.execute(
            "INSERT INTO revisions (title, rev, content, updated_at, updated_by)
             SELECT title, rev, content, updated_at, updated_by FROM pages WHERE id = ?1",
            [id],
        )?;
        tx.execute("DELETE FROM links WHERE src = ?1", [id])?;
        {
            let mut insert =
                tx.prepare("INSERT OR IGNORE INTO links (src, dst) VALUES (?1, ?2)")?;
            for link in wikilinks(content) {
                insert.execute(params![id, link])?;
            }
        }
        tx.commit()?;
        Ok(rev)
    }

    pub fn edit(&mut self, title: &str, old: &str, new: &str, by: &str) -> Result<i64> {
        if old.is_empty() {
            return Err(Error::Invalid("old_text is empty"));
        }
        let (title, content, rev) = self
            .conn
            .query_row(
                "SELECT title, content, rev FROM pages WHERE title = ?1",
                [title],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get(2)?)),
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        match content.matches(old).count() {
            0 => Err(Error::Invalid("old_text not found in page")),
            1 => self.put(&title, &content.replacen(old, new, 1), Some(rev), by),
            _ => Err(Error::Invalid(
                "old_text matches more than once; include more surrounding text",
            )),
        }
    }

    /// BM25 over title and content; an empty query lists recently updated pages.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<Hit>> {
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let Some(query) = fts_query(query) else {
            return self
                .conn
                .prepare_cached(
                    "SELECT p.title, p.rev, p.updated_at, substr(p.content, 1, 200), 0.0, ''
                     FROM pages p JOIN revisions r ON r.title = p.title AND r.rev = p.rev
                     ORDER BY r.rowid DESC LIMIT ?1",
                )?
                .query_map([limit], hit)?
                .collect::<rusqlite::Result<_>>()
                .map_err(Into::into);
        };
        self.conn
            .prepare_cached(
                "SELECT p.title, p.rev, p.updated_at, snippet(pages_fts, 1, '«', '»', '…', 24),
                        -bm25(pages_fts, 10.0, 1.0), substr(p.content, 1, ?3)
                 FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid
                 WHERE pages_fts MATCH ?1 ORDER BY 5 DESC LIMIT ?2",
            )?
            .query_map(params![query, limit, EXCERPT_CHARS], hit)?
            .collect::<rusqlite::Result<_>>()
            .map_err(Into::into)
    }

    pub fn graph(&self) -> Result<Graph> {
        let mut nodes: Vec<_> = self
            .conn
            .prepare_cached("SELECT title FROM pages ORDER BY title")?
            .query_map([], |r| {
                Ok(Node {
                    id: r.get(0)?,
                    missing: false,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        let edges: Vec<(Edge, bool)> = self
            .conn
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

    pub fn all(&self) -> Result<Vec<(String, String)>> {
        self.conn
            .prepare_cached("SELECT title, content FROM pages ORDER BY title")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()
            .map_err(Into::into)
    }
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

/// Titles double as link targets and export file names.
fn valid_title(title: &str) -> Result<&str> {
    let title = title.trim();
    let bad_char = |c: char| c.is_control() || r#"[]|#^/\<>""#.contains(c);
    if title.is_empty()
        || title.chars().count() > 200
        || title.starts_with('.')
        || title.chars().any(bad_char)
    {
        return Err(Error::Invalid(
            r#"title must be 1-200 chars, not start with '.', and not contain [ ] | # ^ / \ < > ""#,
        ));
    }
    Ok(title)
}

/// Obsidian-style `[[Target]]`, `[[Target|alias]]`, `[[Target#heading]]`, outside fenced code.
fn wikilinks(content: &str) -> Vec<&str> {
    content
        .split("```")
        .step_by(2)
        .flat_map(|text| text.split("[[").skip(1))
        .filter_map(|rest| rest.split_once("]]"))
        .filter_map(|(inner, _)| {
            let target = inner
                .split(['|', '#'])
                .next()?
                .trim()
                .trim_end_matches('\\');
            let target = target.strip_suffix(".md").unwrap_or(target);
            (!target.is_empty() && !target.contains('\n')).then_some(target)
        })
        .collect()
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

    #[test]
    fn pages_links_search_and_conflicts() {
        let mut store = Store::open(Path::new(":memory:")).unwrap();
        let redis = "Redis is a cache. See [[ClickHouse|CH]], [[Missing Page#x]] and [[missing page]].\n\
                     ```sh\n[[ -f x ]]\n```";
        assert_eq!(store.put("Redis", redis, Some(0), "t").unwrap(), 1);
        store
            .put(
                "ClickHouse",
                "Column store, used with [[redis]].",
                Some(0),
                "t",
            )
            .unwrap();

        assert!(matches!(
            store.put("redis", "blind overwrite", Some(0), "t"),
            Err(Error::Conflict(1))
        ));
        assert!(matches!(
            store.put("a/b", "x", None, "t"),
            Err(Error::Invalid(_))
        ));
        assert_eq!(
            store.put("Redis", redis, Some(1), "t").unwrap(),
            1,
            "unchanged content keeps rev"
        );

        let page = store.page("redis").unwrap();
        assert_eq!(page.backlinks, ["ClickHouse"]);
        assert_eq!(
            page.links,
            [
                Link {
                    title: "ClickHouse".into(),
                    exists: true
                },
                Link {
                    title: "Missing Page".into(),
                    exists: false
                }
            ]
        );

        assert!(matches!(
            store.edit("Redis", "nope", "x", "t"),
            Err(Error::Invalid(_))
        ));
        assert!(matches!(
            store.edit("Redis", "e", "x", "t"),
            Err(Error::Invalid(_))
        ));
        assert_eq!(
            store
                .edit("Redis", "a cache", "an in-memory cache", "t")
                .unwrap(),
            2
        );

        let hits = store.search("caching", 10).unwrap();
        assert_eq!(hits[0].title, "Redis");
        assert!(hits[0].snippet.contains("«cache»"));
        assert!(store.search("\"unbalanced OR (", 10).is_ok());
        assert_eq!(store.search("", 1).unwrap()[0].title, "Redis");

        let graph = store.graph().unwrap();
        assert_eq!(graph.nodes.iter().filter(|n| n.missing).count(), 1);
        assert_eq!(graph.links.len(), 3);

        let revisions: i64 = store
            .conn
            .query_row("SELECT count(*) FROM revisions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(revisions, 3);
    }
}
