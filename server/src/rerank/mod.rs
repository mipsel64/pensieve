pub mod jev;

use async_trait::async_trait;

use crate::error::Result;

/// Text to judge against a query: a page or a section of one.
pub struct Candidate {
    pub label: String,
    pub text: String,
}

/// Reorders keyword-search candidates by relevance to the query.
#[async_trait]
pub trait Reranker: Send + Sync {
    /// Indices of the relevant `candidates` with their scores, best first; irrelevant ones are left out.
    async fn rerank(&self, query: &str, candidates: &[Candidate]) -> Result<Vec<(usize, f64)>>;
}
