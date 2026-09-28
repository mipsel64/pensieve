pub mod sqlite;

#[cfg(test)]
pub(crate) mod conformance;

pub use sqlite::SqliteStorage;

use std::collections::HashSet;

use async_trait::async_trait;
use serde::Serialize;

use crate::error::{Error, Result};

/// Page store behind the API. Titles are case-insensitive; pages link to each other with `[[Title]]`.
/// New backends implement the required methods and pass [`conformance::check`].
#[async_trait]
pub trait Storage: Send + Sync {
    /// The page with its outgoing links, resolved against existing pages, and its backlinks.
    async fn page(&self, title: &str) -> Result<Page>;

    /// Writes an already validated page with its deduplicated outgoing `links`, keeping every
    /// revision. Fails with `Error::Conflict` unless `base_rev` is `None` or the current rev
    /// (0 when the page doesn't exist). Identical content returns the current rev unchanged.
    async fn save(
        &self,
        title: &str,
        content: &str,
        links: &[&str],
        base_rev: Option<i64>,
        author: &str,
    ) -> Result<i64>;

    /// Best matches first, with matched terms in `snippet` wrapped in `«` `»`.
    /// An empty query lists recently updated pages.
    async fn search(&self, query: &str, limit: usize) -> Result<Vec<Hit>>;

    async fn graph(&self) -> Result<Graph>;

    /// Every page as `(title, content)`, ordered by title.
    async fn pages(&self) -> Result<Vec<(String, String)>>;

    /// Validates and writes a page, returning its rev.
    async fn put(
        &self,
        title: &str,
        content: &str,
        base_rev: Option<i64>,
        author: &str,
    ) -> Result<i64> {
        let title = validate_title(title)?;
        if content.trim().is_empty() {
            return Err(Error::Invalid {
                reason: "cannot save a page with empty content",
            });
        }
        self.save(title, content, &wikilinks(content), base_rev, author)
            .await
    }

    /// Replaces the single occurrence of `old` in a page, returning its new rev.
    async fn edit(&self, title: &str, old: &str, new: &str, author: &str) -> Result<i64> {
        if old.is_empty() {
            return Err(Error::Invalid {
                reason: "cannot edit: old_text is empty",
            });
        }
        let page = self.page(title).await?;
        match page.content.matches(old).count() {
            0 => Err(Error::Invalid {
                reason: "cannot edit: old_text not found in page",
            }),
            1 => {
                let content = page.content.replacen(old, new, 1);
                self.put(&page.title, &content, Some(page.rev), author)
                    .await
            }
            _ => Err(Error::Invalid {
                reason: "cannot edit: old_text matches more than once; include more surrounding text",
            }),
        }
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct Hit {
    pub title: String,
    pub rev: i64,
    pub updated_at: String,
    pub snippet: String,
    pub score: f64,
    /// Leading page text, sent to rerankers.
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

/// Titles double as link targets and export file names.
fn validate_title(title: &str) -> Result<&str> {
    let title = title.trim();
    let bad_char = |c: char| c.is_control() || r#"[]|#^/\<>""#.contains(c);
    if title.is_empty()
        || title.chars().count() > 200
        || title.starts_with('.')
        || title.chars().any(bad_char)
    {
        return Err(Error::Invalid {
            reason: r#"cannot use title: it must be 1-200 characters, not start with '.', and not contain [ ] | # ^ / \ < > ""#,
        });
    }
    Ok(title)
}

/// Obsidian-style `[[Target]]`, `[[Target|alias]]`, `[[Target#heading]]` outside fenced code,
/// first spelling wins among case variants.
fn wikilinks(content: &str) -> Vec<&str> {
    let mut seen = HashSet::new();
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
        .filter(|target| seen.insert(target.to_lowercase()))
        .collect()
}
