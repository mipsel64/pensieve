use std::collections::HashMap;

use crate::{
    error::Result,
    rerank::{Candidate, Reranker},
    storage::{Hit, Passage, Storage},
};

/// Candidate pool handed to the reranker; recall is bounded by keyword search at this depth.
const CANDIDATES: usize = 40;
/// Passages per page in one recall, so one long page can't crowd out the others.
const PER_PAGE: usize = 3;
const MAX_LEADS: usize = 8;
/// Bytes per section sent to the reranker; covers all but the longest sections, and the reranker
/// splits batches to fit its request limit.
const EXCERPT_BYTES: usize = 6000;
pub const DEFAULT_BUDGET: usize = 2000;
pub const MAX_BUDGET: usize = 8000;
/// Question words too common to signal relevance; with any-term matching they would match every page.
const STOPWORDS: &[&str] = &[
    "a", "about", "an", "and", "any", "are", "as", "at", "be", "but", "by", "can", "could", "did",
    "do", "does", "for", "from", "had", "has", "have", "how", "i", "if", "in", "into", "is", "it",
    "its", "me", "my", "no", "not", "of", "on", "or", "our", "should", "so", "than", "that", "the",
    "their", "them", "then", "there", "these", "they", "this", "to", "us", "was", "we", "were",
    "what", "when", "where", "which", "while", "who", "why", "will", "with", "would", "you",
    "your",
];

pub struct Searched {
    pub hits: Vec<Hit>,
    pub reranked: bool,
}

pub struct Recalled {
    /// Pages in rank order of their best passage, each page's passages in document order.
    pub passages: Vec<Passage>,
    /// Typed pages worth reading that weren't included: other matches, then pages the top results link to.
    pub leads: Vec<String>,
    pub reranked: bool,
    pub tokens: usize,
}

/// Page-level keyword search, reranked when a reranker is configured. Falls back to keyword order if it fails.
pub async fn search(
    storage: &dyn Storage,
    reranker: Option<&dyn Reranker>,
    query: &str,
    limit: usize,
) -> Result<Searched> {
    let reranker = reranker.filter(|_| !query.trim().is_empty());
    let mut hits = storage
        .search(
            query,
            if reranker.is_some() {
                CANDIDATES.max(limit)
            } else {
                limit
            },
        )
        .await?;
    if let Some(reranker) = reranker {
        let candidates: Vec<_> = hits
            .iter()
            .map(|h| Candidate {
                label: h.title.clone(),
                text: h.excerpt.clone(),
            })
            .collect();
        match reranker.rerank(query, &candidates).await {
            Ok(ranked) => {
                let hits = ranked
                    .into_iter()
                    .take(limit)
                    .map(|(i, score)| Hit {
                        score,
                        ..hits[i].clone()
                    })
                    .collect();
                return Ok(Searched {
                    hits,
                    reranked: true,
                });
            }
            Err(e) => eprintln!("{e}; falling back to keyword ranking"),
        }
    }
    hits.truncate(limit);
    Ok(Searched {
        hits,
        reranked: false,
    })
}

/// The passages most relevant to `question`, packed into roughly `budget` tokens.
pub async fn recall(
    storage: &dyn Storage,
    reranker: Option<&dyn Reranker>,
    question: &str,
    keywords: &[String],
    budget: usize,
) -> Result<Recalled> {
    let mut terms: Vec<_> = question
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty() && !STOPWORDS.contains(&w.to_lowercase().as_str()))
        .map(str::to_owned)
        .collect();
    terms.extend(keywords.iter().cloned());
    let matches = storage.search_sections(&terms, CANDIDATES).await?;

    let mut ranked = matches.clone();
    let mut reranked = false;
    if let Some(reranker) = reranker.filter(|_| !matches.is_empty()) {
        let candidates: Vec<_> = matches
            .iter()
            .map(|p| Candidate {
                label: label(p),
                text: truncate(&p.text, EXCERPT_BYTES).to_owned(),
            })
            .collect();
        match reranker.rerank(question, &candidates).await {
            Ok(order) => {
                ranked = order
                    .into_iter()
                    .map(|(i, score)| Passage {
                        score,
                        ..matches[i].clone()
                    })
                    .collect();
                reranked = true;
            }
            Err(e) => eprintln!("{e}; falling back to keyword ranking"),
        }
    }

    let (mut passages, mut tokens) = (Vec::new(), 0);
    let mut per_page: HashMap<String, usize> = HashMap::new();
    for mut passage in ranked {
        let taken = per_page.entry(passage.title.clone()).or_default();
        let cost = cost(&passage);
        if *taken >= PER_PAGE || (tokens + cost > budget && !passages.is_empty()) {
            continue;
        }
        if tokens + cost > budget {
            // The best passage alone is over budget: return its start rather than nothing.
            const MORE: &str = "… [truncated; read the section for the rest]";
            let overhead = cost - passage.text.len() / 4 + MORE.len() / 4 + 1;
            let keep = budget.saturating_sub(overhead) * 4;
            passage.text = format!("{}{MORE}", truncate(&passage.text, keep));
        }
        tokens += self::cost(&passage);
        *taken += 1;
        passages.push(passage);
    }
    let order: Vec<String> = passages.iter().fold(Vec::new(), |mut order, p| {
        if !order.contains(&p.title) {
            order.push(p.title.clone());
        }
        order
    });
    passages.sort_by_key(|p| (order.iter().position(|t| *t == p.title), p.ord));

    let mut leads: Vec<String> = Vec::new();
    let mut add_lead = |title: &str| {
        let known = order
            .iter()
            .chain(&leads)
            .any(|t| t.eq_ignore_ascii_case(title));
        if !known && leads.len() < MAX_LEADS {
            leads.push(title.to_owned());
        }
    };
    // Untyped pages are mostly hubs and indexes that match or link to everything.
    for passage in matches.iter().filter(|p| p.kind.is_some()) {
        add_lead(&passage.title);
    }
    for title in order.iter().take(3) {
        storage
            .visit(title)
            .await
            .unwrap_or_else(|e| eprintln!("{e}"));
        if let Ok(page) = storage.page(title).await {
            page.links
                .iter()
                .filter(|l| l.kind.is_some())
                .for_each(|l| add_lead(&l.title));
        }
    }
    for title in order.iter().skip(3) {
        storage
            .visit(title)
            .await
            .unwrap_or_else(|e| eprintln!("{e}"));
    }
    Ok(Recalled {
        passages,
        leads,
        reranked,
        tokens,
    })
}

pub fn label(passage: &Passage) -> String {
    if passage.heading.is_empty() {
        passage.title.clone()
    } else {
        format!("{} › {}", passage.title, passage.heading)
    }
}

/// Rough token estimate for a passage as `recall` prints it, header line included.
fn cost(passage: &Passage) -> usize {
    (label(passage).len() + passage.text.len()) / 4 + 20
}

fn truncate(text: &str, max_bytes: usize) -> &str {
    let mut end = max_bytes.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}
