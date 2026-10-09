use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header},
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
    retrieval::{self, DEFAULT_BUDGET, MAX_BUDGET},
    session,
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
        .route("/recall", get(recall))
        .route(
            "/settings",
            get(settings)
                .put(save_settings)
                .layer(DefaultBodyLimit::max(MAX_SETTINGS_BYTES)),
        )
        .route_layer(middleware::from_fn_with_state(app.clone(), auth))
        .route("/login", post(login))
        .route(
            "/logout",
            post(|| async {
                (
                    StatusCode::NO_CONTENT,
                    [(header::SET_COOKIE, session::clear())],
                )
            }),
        );
    Router::new()
        .route("/mcp", post(mcp))
        .route_layer(middleware::from_fn_with_state(app.clone(), auth))
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
        Some("woff2") => "font/woff2",
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

/// Agents authenticate with the bearer token; the web UI with a session cookie, which only
/// authorizes reads so a cross-site form can't write with it. The one exception, the UI's own
/// settings, takes only a JSON body, which a cross-site page can't send without CORS approval.
async fn auth(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, token)| token.trim())
        .is_some_and(|token| bool::from(token.as_bytes().ct_eq(app.token.as_bytes())));
    let read = matches!(*request.method(), Method::GET | Method::HEAD)
        || request.uri().path() == "/settings";
    if !(bearer || (read && session::valid(&app.token, headers))) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

const MAX_SETTINGS_BYTES: usize = 16 * 1024;

async fn settings(State(app): State<Arc<App>>) -> Result<Response> {
    let json = app.storage.settings().await?.unwrap_or_else(|| "{}".into());
    Ok(([(header::CONTENT_TYPE, "application/json")], json).into_response())
}

async fn save_settings(State(app): State<Arc<App>>, Json(value): Json<Value>) -> Response {
    let json = value.to_string();
    if !value.is_object() || json.len() > MAX_SETTINGS_BYTES {
        return (
            StatusCode::BAD_REQUEST,
            format!(
                "cannot save settings: send a JSON object of at most {MAX_SETTINGS_BYTES} bytes"
            ),
        )
            .into_response();
    }
    match app.storage.save_settings(&json).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => e.into_response(),
    }
}

#[derive(Deserialize)]
struct LoginBody {
    token: String,
}

async fn login(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> Response {
    if !bool::from(body.token.trim().as_bytes().ct_eq(app.token.as_bytes())) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    (
        StatusCode::NO_CONTENT,
        [(header::SET_COOKIE, session::issue(&app.token, &headers))],
    )
        .into_response()
}

#[derive(Deserialize)]
struct RecallParams {
    q: String,
    /// Comma-separated.
    #[serde(default)]
    keywords: String,
    budget: Option<usize>,
    #[serde(rename = "type")]
    kind: Option<String>,
}

async fn recall(
    State(app): State<Arc<App>>,
    Query(params): Query<RecallParams>,
) -> Result<Json<Value>> {
    let keywords: Vec<_> = params
        .keywords
        .split(',')
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .take(retrieval::MAX_KEYWORDS)
        .map(str::to_owned)
        .collect();
    let budget = params
        .budget
        .unwrap_or(DEFAULT_BUDGET)
        .clamp(200, MAX_BUDGET);
    let recalled = retrieval::recall(
        app.storage.as_ref(),
        app.reranker.as_deref(),
        &params.q,
        &keywords,
        params.kind.as_deref(),
        budget,
    )
    .await?;
    Ok(Json(json!({
        "reranked": recalled.reranked,
        "tokens": recalled.tokens,
        "passages": recalled.passages,
        "leads": recalled.leads,
    })))
}

#[derive(Deserialize)]
struct SearchParams {
    #[serde(default)]
    q: String,
    limit: Option<usize>,
    rerank: Option<bool>,
    #[serde(rename = "type")]
    kind: Option<String>,
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
    let found = retrieval::search(
        app.storage.as_ref(),
        reranker,
        &params.q,
        params.kind.as_deref(),
        limit,
    )
    .await?;
    Ok(Json(
        json!({ "reranked": found.reranked, "hits": found.hits }),
    ))
}

async fn graph(State(app): State<Arc<App>>) -> Result<Json<Graph>> {
    Ok(Json(app.storage.graph().await?))
}

#[derive(Deserialize)]
struct ReadParams {
    /// `false` for maintenance scripts, whose reads aren't usage.
    visit: Option<bool>,
}

async fn read(
    State(app): State<Arc<App>>,
    Path(title): Path<String>,
    Query(params): Query<ReadParams>,
) -> Result<Json<Page>> {
    let page = app.storage.page(&title).await?;
    // Bookkeeping only: a failed visit must not fail the read. The response keeps the previous visit.
    if params.visit.unwrap_or(true)
        && let Err(e) = app.storage.visit(&page.title).await
    {
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
    Ok(Json(json!({ "title": title.trim(), "rev": rev })))
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
    Ok(Json(json!({ "title": title.trim(), "rev": rev })))
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

#[cfg(test)]
mod tests {
    use std::path::Path;

    use reqwest::{Client, StatusCode};

    use super::*;
    use crate::storage::SqliteStorage;

    #[tokio::test]
    async fn old_journals_require_type() {
        let token = "test-token-0123456789";
        let storage = Arc::new(SqliteStorage::open(Path::new(":memory:")).unwrap());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/api", listener.local_addr().unwrap());
        let app = Arc::new(App {
            storage,
            reranker: None,
            token: token.into(),
        });
        tokio::spawn(axum::serve(listener, router(app)).into_future());
        let http = Client::new();
        for (title, kind) in [("Redis", "topic"), ("Scratchpad", "journal")] {
            let response = http
                .put(format!("{base}/pages/{title}"))
                .bearer_auth(token)
                .json(&json!({ "content": format!("---\ntype: {kind}\n---\nRedis cache notes.") }))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }
        for path in ["/search?q=cache", "/search", "/recall?q=cache"] {
            let response: Value = http
                .get(format!("{base}{path}"))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let entries = response[if path.starts_with("/search") {
                "hits"
            } else {
                "passages"
            }]
            .as_array()
            .unwrap();
            let mut titles: Vec<_> = entries.iter().filter_map(|e| e["title"].as_str()).collect();
            titles.sort_unstable();
            titles.dedup();
            let expected: &[&str] = if path.starts_with("/search") {
                &["Redis"]
            } else {
                &["Redis", "Scratchpad"]
            };
            assert_eq!(titles, expected, "{path}: {response}");
            assert!(
                response["leads"]
                    .as_array()
                    .is_none_or(|leads| leads.is_empty()),
                "{path}: {response}"
            );
        }
        for path in [
            "/search?q=cache&type=journal",
            "/search?type=journal",
            "/recall?q=cache&type=journal",
        ] {
            let response: Value = http
                .get(format!("{base}{path}"))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let entries = response[if path.starts_with("/search") {
                "hits"
            } else {
                "passages"
            }]
            .as_array()
            .unwrap();
            assert!(
                entries.iter().all(|entry| entry["title"] == "Scratchpad") && !entries.is_empty(),
                "{path}: {response}"
            );
            assert!(
                response["leads"]
                    .as_array()
                    .is_none_or(|leads| leads.is_empty()),
                "{path}: {response}"
            );
        }
        for path in ["/search?type=wrong", "/recall?q=cache&type=wrong"] {
            let response = http
                .get(format!("{base}{path}"))
                .bearer_auth(token)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
            assert!(
                response
                    .text()
                    .await
                    .unwrap()
                    .contains("cannot use type \"wrong\"; use one of:")
            );
        }
    }

    #[tokio::test]
    async fn browser_sessions_read_but_never_write() {
        let token = "test-token-0123456789".to_owned();
        let storage = Arc::new(SqliteStorage::open(Path::new(":memory:")).unwrap());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let base = format!("{root}/api");
        let app = Arc::new(App {
            storage,
            reranker: None,
            token: token.clone(),
        });
        tokio::spawn(axum::serve(listener, router(app)).into_future());
        let http = Client::new();

        let wrong = http
            .post(format!("{base}/login"))
            .json(&json!({ "token": "nope" }))
            .send()
            .await
            .unwrap();
        assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
        let login = http
            .post(format!("{base}/login"))
            .json(&json!({ "token": token }))
            .send()
            .await
            .unwrap();
        assert_eq!(login.status(), StatusCode::NO_CONTENT);
        let cookie = login.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();

        let get = |path: &str| {
            http.get(format!("{base}{path}"))
                .header(header::COOKIE, &cookie)
                .send()
        };
        let put = http
            .put(format!("{base}/pages/Seen"))
            .bearer_auth(&token)
            .json(&json!({ "content": "x" }))
            .send()
            .await
            .unwrap();
        assert_eq!(put.status(), StatusCode::OK);
        let quiet: Value = get("/pages/Seen?visit=false")
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let counted: Value = get("/pages/Seen").await.unwrap().json().await.unwrap();
        assert!(
            quiet["visited_at"].is_null() && counted["visited_at"].is_null(),
            "each read returns the previous visit"
        );
        let after: Value = get("/pages/Seen").await.unwrap().json().await.unwrap();
        assert!(
            after["visited_at"].is_string(),
            "only the second read counted"
        );
        assert_eq!(get("/stats").await.unwrap().status(), StatusCode::OK);

        let save = |body: Value| {
            http.put(format!("{base}/settings"))
                .header(header::COOKIE, &cookie)
                .json(&body)
                .send()
        };
        assert_eq!(
            save(json!({ "graph": { "arrows": true } }))
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT,
            "the UI saves its settings with the cookie"
        );
        let saved: Value = get("/settings").await.unwrap().json().await.unwrap();
        assert_eq!(saved, json!({ "graph": { "arrows": true } }));
        assert_eq!(
            save(json!([1])).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
        let form = http
            .put(format!("{base}/settings"))
            .header(header::COOKIE, &cookie)
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body("graph=1")
            .send()
            .await
            .unwrap();
        assert_eq!(form.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        let padded = format!("{{{}}}", " ".repeat(MAX_SETTINGS_BYTES));
        let big = http
            .put(format!("{base}/settings"))
            .header(header::COOKIE, &cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .body(padded)
            .send()
            .await
            .unwrap();
        assert_eq!(
            big.status(),
            StatusCode::PAYLOAD_TOO_LARGE,
            "the limit is on the body, not the parsed value"
        );
        assert_eq!(
            http.get(format!("{base}/stats"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );

        let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
        let with_cookie = http
            .post(format!("{root}/mcp"))
            .header(header::COOKIE, &cookie)
            .json(&ping)
            .send()
            .await
            .unwrap();
        assert_eq!(
            with_cookie.status(),
            StatusCode::UNAUTHORIZED,
            "cookies never authorize writes"
        );
        let page = json!({ "content": "x" });
        let put = http
            .put(format!("{base}/pages/X"))
            .header(header::COOKIE, &cookie)
            .json(&page)
            .send()
            .await
            .unwrap();
        assert_eq!(put.status(), StatusCode::UNAUTHORIZED);
        let with_bearer = http
            .post(format!("{root}/mcp"))
            .bearer_auth(&token)
            .json(&ping)
            .send()
            .await
            .unwrap();
        assert_eq!(with_bearer.status(), StatusCode::OK);

        let logout = http.post(format!("{base}/logout")).send().await.unwrap();
        assert!(
            logout.headers()[header::SET_COOKIE]
                .to_str()
                .unwrap()
                .contains("Max-Age=0")
        );
    }
}
