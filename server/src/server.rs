use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;

use crate::{
    error::Result,
    rerank::Reranker,
    storage::{Graph, Page, Storage},
};

/// Candidate pool handed to the reranker; recall is bounded by keyword search at this depth.
const CANDIDATES: usize = 40;
const CSP: &str = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'";

pub struct App {
    pub storage: Arc<dyn Storage>,
    pub reranker: Option<Arc<dyn Reranker>>,
    pub token: String,
}

pub fn router(app: Arc<App>) -> Router {
    let api = Router::new()
        .route("/search", get(search))
        .route("/graph", get(graph))
        .route("/pages/{title}", get(read).put(write))
        .route("/pages/{title}/edit", post(edit))
        .route_layer(middleware::from_fn_with_state(app.clone(), auth));
    Router::new()
        .route(
            "/",
            get(|| async {
                asset(
                    "text/html; charset=utf-8",
                    include_str!("../web/index.html"),
                )
            }),
        )
        .route(
            "/app.js",
            get(|| async { asset("text/javascript", include_str!("../web/app.js")) }),
        )
        .route(
            "/force-graph.min.js",
            get(|| async { asset("text/javascript", include_str!("../web/force-graph.min.js")) }),
        )
        .nest("/api", api)
        .with_state(app)
}

fn asset(content_type: &'static str, body: &'static str) -> Response {
    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CONTENT_SECURITY_POLICY, CSP),
        ],
        body,
    )
        .into_response()
}

async fn auth(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let authorized = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|token| bool::from(token.as_bytes().ct_eq(app.token.as_bytes())));
    if !authorized {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[derive(Deserialize)]
struct SearchParams {
    #[serde(default)]
    q: String,
    limit: Option<usize>,
    rerank: Option<bool>,
}

async fn search(
    State(app): State<Arc<App>>,
    Query(params): Query<SearchParams>,
) -> Result<Json<Value>> {
    let limit = params.limit.unwrap_or(10).clamp(1, 50);
    let reranker = app
        .reranker
        .as_ref()
        .filter(|_| params.rerank.unwrap_or(true) && !params.q.trim().is_empty());
    let candidates = if reranker.is_some() {
        CANDIDATES.max(limit)
    } else {
        limit
    };
    let mut hits = app.storage.search(&params.q, candidates).await?;
    if let Some(reranker) = reranker {
        match reranker.rerank(&params.q, &hits, limit).await {
            Ok(ranked) => return Ok(Json(json!({ "reranked": true, "hits": ranked }))),
            Err(e) => eprintln!("{e}; falling back to keyword ranking"),
        }
    }
    hits.truncate(limit);
    Ok(Json(json!({ "reranked": false, "hits": hits })))
}

async fn graph(State(app): State<Arc<App>>) -> Result<Json<Graph>> {
    Ok(Json(app.storage.graph().await?))
}

async fn read(State(app): State<Arc<App>>, Path(title): Path<String>) -> Result<Json<Page>> {
    Ok(Json(app.storage.page(&title).await?))
}

#[derive(Deserialize)]
struct WriteBody {
    content: String,
    base_rev: Option<i64>,
}

async fn write(
    State(app): State<Arc<App>>,
    Path(title): Path<String>,
    headers: HeaderMap,
    Json(body): Json<WriteBody>,
) -> Result<Json<Value>> {
    let base_rev = Some(body.base_rev.unwrap_or(0));
    let rev = app
        .storage
        .put(&title, &body.content, base_rev, &agent(&headers))
        .await?;
    Ok(Json(json!({ "title": title, "rev": rev })))
}

#[derive(Deserialize)]
struct EditBody {
    old_text: String,
    new_text: String,
}

async fn edit(
    State(app): State<Arc<App>>,
    Path(title): Path<String>,
    headers: HeaderMap,
    Json(body): Json<EditBody>,
) -> Result<Json<Value>> {
    let rev = app
        .storage
        .edit(&title, &body.old_text, &body.new_text, &agent(&headers))
        .await?;
    Ok(Json(json!({ "title": title, "rev": rev })))
}

fn agent(headers: &HeaderMap) -> String {
    let agent = headers
        .get("x-pensieve-agent")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown");
    agent.chars().take(64).collect()
}
