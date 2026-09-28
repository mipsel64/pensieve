pub mod jev;

use async_trait::async_trait;

use crate::{error::Result, storage::Hit};

/// Reorders keyword-search candidates by relevance to the query.
#[async_trait]
pub trait Reranker: Send + Sync {
    /// Relevant `hits` only, best first, at most `limit`, with `score` set to the reranker's score.
    async fn rerank(&self, query: &str, hits: &[Hit], limit: usize) -> Result<Vec<Hit>>;
}
