pub mod sqlite;

#[cfg(test)]
pub(crate) mod conformance;

pub use sqlite::SqliteStorage;

use std::time::SystemTime;

use async_trait::async_trait;
use serde::Serialize;

use crate::{
    error::{Error, Result},
    markdown::{self, KINDS, Section},
};

/// Page store behind the API. Titles are case-insensitive; pages link to each other with `[[Title]]`.
/// New backends implement the required methods and pass [`conformance::check`].
#[async_trait]
pub trait Storage: Send + Sync {
    /// The page with its outgoing links, resolved against existing pages, and its backlinks.
    async fn page(&self, title: &str) -> Result<Page>;

    /// Writes a validated page with its derived index data, keeping every revision.
    /// Fails with `Error::Conflict` unless `draft.base_rev` is `None` or the current rev
    /// (0 when the page doesn't exist). Identical content returns the current rev unchanged.
    async fn save(&self, draft: Draft) -> Result<i64>;

    /// Pages, best matches first, with matched terms in `snippet` wrapped in `«` `»`.
    /// An empty query lists recently updated pages. Without a type, journals are excluded.
    async fn search(&self, query: &str, kind: Option<&str>, limit: usize) -> Result<Vec<Hit>>;

    /// Sections matching any of `terms`, best first. Multi-word terms match as phrases.
    /// Without a type, journals are excluded unless updated at or after `recent_journals_since`.
    async fn search_sections(
        &self,
        terms: &[String],
        kind: Option<&str>,
        recent_journals_since: SystemTime,
        limit: usize,
    ) -> Result<Vec<Passage>>;

    /// Records that a page was read now, for staleness-based eviction.
    async fn visit(&self, title: &str) -> Result<()>;

    async fn graph(&self) -> Result<Graph>;

    /// Page writes, newest first. `filter.before` pages through older entries by `Revision::seq`.
    async fn history(&self, filter: &HistoryFilter, limit: usize) -> Result<Vec<Revision>>;

    /// Aggregates for the memory map, dashboard and activity views.
    async fn stats(&self) -> Result<Stats>;

    /// Every page as `(title, content)`, ordered by title.
    async fn pages(&self) -> Result<Vec<(String, String)>>;

    /// The web UI's settings as saved JSON, if any were saved.
    async fn settings(&self) -> Result<Option<String>>;

    async fn save_settings(&self, json: &str) -> Result<()>;

    /// Validates and writes a page, returning its rev.
    async fn put(
        &self,
        title: &str,
        content: &str,
        base_rev: Option<i64>,
        change: Change<'_>,
    ) -> Result<i64> {
        self.save(Draft::new(title, content, base_rev, change)?)
            .await
    }

    /// Replaces the single occurrence of `old` in a page, returning its new rev.
    async fn edit(&self, title: &str, old: &str, new: &str, change: Change<'_>) -> Result<i64> {
        if old.is_empty() {
            return Err(Error::invalid("cannot edit: old_text is empty"));
        }
        let page = self.page(title).await?;
        // Counted with overlaps: in "aaa", "aa" is ambiguous.
        let content = &page.content;
        let found = content.find(old).map_or(0, |i| {
            let next = i + content[i..].chars().next().map_or(1, char::len_utf8);
            if content[next..].contains(old) { 2 } else { 1 }
        });
        match found {
            0 => Err(Error::invalid("cannot edit: old_text not found in page")),
            1 => {
                self.put(
                    &page.title,
                    &page.content.replacen(old, new, 1),
                    Some(page.rev),
                    change,
                )
                .await
            }
            _ => Err(Error::invalid(
                "cannot edit: old_text matches more than once; include more surrounding text",
            )),
        }
    }

    /// Adds `text` to the end of a section, returning the page's new rev.
    async fn append(
        &self,
        title: &str,
        section: &str,
        text: &str,
        change: Change<'_>,
    ) -> Result<i64> {
        if text.trim().is_empty() {
            return Err(Error::invalid("cannot append: text is empty"));
        }
        let page = self.page(title).await?;
        let Some(content) = markdown::append_to_section(&page.content, section, text) else {
            let names = markdown::section_names(&page.content).join(", ");
            return Err(Error::invalid(format!(
                "cannot find section {section:?}; sections: {names}"
            )));
        };
        self.put(&page.title, &content, Some(page.rev), change)
            .await
    }
}

/// Who made a write and why.
#[derive(Clone, Copy)]
pub struct Change<'a> {
    pub author: &'a str,
    pub summary: Option<&'a str>,
}

/// A validated page write with everything derived from its content.
pub struct Draft {
    pub title: String,
    pub content: String,
    pub kind: Option<String>,
    pub confidence: Option<String>,
    pub links: Vec<String>,
    pub sections: Vec<Section>,
    pub base_rev: Option<i64>,
    pub author: String,
    pub summary: Option<String>,
}

impl Draft {
    pub fn new(
        title: &str,
        content: &str,
        base_rev: Option<i64>,
        change: Change<'_>,
    ) -> Result<Self> {
        let title = validate_title(title)?;
        if content.trim().is_empty() {
            return Err(Error::invalid("cannot save a page with empty content"));
        }
        let kind = markdown::field(content, "type");
        validate_kind(kind.as_deref())?;
        Ok(Self {
            title: title.to_owned(),
            content: content.to_owned(),
            kind,
            confidence: markdown::field(content, "confidence"),
            links: markdown::wikilinks(content),
            sections: markdown::sections(content),
            base_rev,
            author: change.author.to_owned(),
            summary: change
                .summary
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
        })
    }
}

pub fn validate_kind(kind: Option<&str>) -> Result<()> {
    if let Some(kind) = kind.filter(|kind| !KINDS.contains(kind)) {
        return Err(Error::invalid(format!(
            "cannot use type {kind:?}; use one of: {}",
            KINDS.join(", ")
        )));
    }
    Ok(())
}

#[derive(Serialize, Clone, Debug)]
pub struct Hit {
    pub title: String,
    pub rev: i64,
    pub updated_at: String,
    pub snippet: String,
    pub score: f64,
    pub kind: Option<String>,
    /// Leading page text, sent to rerankers.
    #[serde(skip)]
    pub excerpt: String,
}

/// One section of a page, as returned by `search_sections`.
#[derive(Serialize, Clone, Debug)]
pub struct Passage {
    pub title: String,
    pub heading: String,
    /// Position of the section in its page.
    pub ord: i64,
    pub text: String,
    pub rev: i64,
    pub updated_at: String,
    pub kind: Option<String>,
    pub confidence: Option<String>,
    pub score: f64,
}

#[derive(Serialize)]
pub struct Page {
    pub title: String,
    pub content: String,
    pub rev: i64,
    pub kind: Option<String>,
    pub confidence: Option<String>,
    pub updated_at: String,
    pub updated_by: String,
    /// Last recorded read; `None` if never read.
    pub visited_at: Option<String>,
    pub links: Vec<Link>,
    pub backlinks: Vec<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Link {
    pub title: String,
    pub exists: bool,
    pub kind: Option<String>,
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
    pub kind: Option<String>,
}

#[derive(Serialize)]
pub struct Edge {
    pub source: String,
    pub target: String,
}

#[derive(Clone, Default)]
pub struct HistoryFilter {
    pub title: Option<String>,
    pub author: Option<String>,
    pub before: Option<i64>,
}

#[derive(Serialize, Debug)]
pub struct Revision {
    /// Increases with every write; the cursor for `HistoryFilter::before`.
    pub seq: i64,
    pub title: String,
    pub rev: i64,
    pub at: String,
    pub by: String,
    pub summary: Option<String>,
    pub bytes: i64,
}

#[derive(Serialize)]
pub struct Stats {
    pub pages: i64,
    pub links: i64,
    pub revisions: i64,
    pub never_visited: i64,
    /// Pages per frontmatter `type`, with `untyped` for pages without one.
    pub kinds: Vec<Count>,
    /// Link targets without a page, most referenced first.
    pub missing: Vec<Count>,
    pub missing_total: i64,
    /// Pages no other page links to.
    pub orphans: Vec<String>,
    pub orphans_total: i64,
    /// Most linked-to pages.
    pub hubs: Vec<Count>,
    pub authors: Vec<Author>,
    /// Writes per UTC day over the last 53 weeks, oldest first; days without writes are omitted.
    pub days: Vec<Count>,
    pub recent_visits: Vec<Visit>,
    /// Pages untouched longest, by the later of their last write and last visit.
    pub stale: Vec<Stale>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Count {
    pub name: String,
    pub count: i64,
}

#[derive(Serialize)]
pub struct Author {
    pub name: String,
    pub writes: i64,
    pub pages: i64,
    pub last_at: String,
}

#[derive(Serialize)]
pub struct Visit {
    pub title: String,
    pub at: String,
}

#[derive(Serialize)]
pub struct Stale {
    pub title: String,
    pub updated_at: String,
    pub visited_at: Option<String>,
}

/// Titles double as link targets and export file names.
fn validate_title(title: &str) -> Result<&str> {
    let title = title.trim();
    let bad_char = |c: char| c.is_control() || r#"[]|#^/\<>""#.contains(c);
    if title.is_empty()
        || title.chars().count() > 200
        || title.starts_with('.')
        || title.chars().any(bad_char)
    {
        return Err(Error::invalid(
            r#"cannot use title: it must be 1-200 characters, not start with '.', and not contain [ ] | # ^ / \ < > ""#,
        ));
    }
    Ok(title)
}
