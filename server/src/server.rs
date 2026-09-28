use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use include_dir::{Dir, include_dir};
use serde::Deserialize;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;

use crate::{
    error::Result,
    mcp,
    rerank::Reranker,
    retrieval,
    storage::{Change, Graph, HistoryFilter, Page, Revision, Stats, Storage},
};

const CSP: &str = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'";
static WEB: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/web/dist");

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
        .route("/history", get(history))
        .route("/stats", get(stats))
        .route("/mcp", post(mcp))
        .route_layer(middleware::from_fn_with_state(app.clone(), auth));
    Router::new()
        .nest("/api", api)
        .fallback(asset)
        .with_state(app)
}

async fn asset(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let Some(file) = WEB.get_file(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let content_type = match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    };
    // Vite puts a content hash in every file name under assets/.
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, cache),
            (header::CONTENT_SECURITY_POLICY, CSP),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        file.contents(),
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
        .as_deref()
        .filter(|_| params.rerank.unwrap_or(true));
    let found = retrieval::search(app.storage.as_ref(), reranker, &params.q, limit).await?;
    Ok(Json(
        json!({ "reranked": found.reranked, "hits": found.hits }),
    ))
}

async fn graph(State(app): State<Arc<App>>) -> Result<Json<Graph>> {
    Ok(Json(app.storage.graph().await?))
}

async fn read(State(app): State<Arc<App>>, Path(title): Path<String>) -> Result<Json<Page>> {
    let page = app.storage.page(&title).await?;
    // Bookkeeping only: a failed visit must not fail the read. The response keeps the previous visit.
    if let Err(e) = app.storage.visit(&page.title).await {
        eprintln!("{e}");
    }
    Ok(Json(page))
}

#[derive(Deserialize)]
struct WriteBody {
    content: String,
    base_rev: Option<i64>,
    summary: Option<String>,
}

async fn write(
    State(app): State<Arc<App>>,
    Path(title): Path<String>,
    headers: HeaderMap,
    Json(body): Json<WriteBody>,
) -> Result<Json<Value>> {
    let change = Change {
        author: &agent(&headers),
        summary: body.summary.as_deref(),
    };
    let rev = app
        .storage
        .put(
            &title,
            &body.content,
            Some(body.base_rev.unwrap_or(0)),
            change,
        )
        .await?;
    Ok(Json(json!({ "title": title, "rev": rev })))
}

#[derive(Deserialize)]
struct EditBody {
    old_text: String,
    new_text: String,
    summary: Option<String>,
}

async fn edit(
    State(app): State<Arc<App>>,
    Path(title): Path<String>,
    headers: HeaderMap,
    Json(body): Json<EditBody>,
) -> Result<Json<Value>> {
    let change = Change {
        author: &agent(&headers),
        summary: body.summary.as_deref(),
    };
    let rev = app
        .storage
        .edit(&title, &body.old_text, &body.new_text, change)
        .await?;
    Ok(Json(json!({ "title": title, "rev": rev })))
}

#[derive(Deserialize)]
struct HistoryParams {
    title: Option<String>,
    author: Option<String>,
    before: Option<i64>,
    limit: Option<usize>,
}

async fn history(
    State(app): State<Arc<App>>,
    Query(params): Query<HistoryParams>,
) -> Result<Json<Vec<Revision>>> {
    let filter = HistoryFilter {
        title: params.title,
        author: params.author,
        before: params.before,
    };
    Ok(Json(
        app.storage
            .history(&filter, params.limit.unwrap_or(50).clamp(1, 200))
            .await?,
    ))
}

async fn stats(State(app): State<Arc<App>>) -> Result<Json<Stats>> {
    Ok(Json(app.storage.stats().await?))
}

async fn mcp(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(message): Json<Value>,
) -> Response {
    match mcp::handle(&app, &agent(&headers), &message).await {
        Some(reply) => Json(reply).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

fn agent(headers: &HeaderMap) -> String {
    let agent = headers
        .get("x-pensieve-agent")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown");
    agent.chars().take(64).collect()
}
