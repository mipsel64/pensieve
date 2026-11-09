use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

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
    oauth::{self, OAuth},
    rerank::Reranker,
    retrieval::{self, DEFAULT_BUDGET, MAX_BUDGET},
    session::{self, Subject},
    storage::{Change, Grant, Graph, HistoryFilter, Page, Revision, Stats, Storage},
};

const CSP: &str = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'";
static WEB: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/web/dist");

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_secs() as i64)
    })
}

pub struct App {
    pub storage: Arc<dyn Storage>,
    pub reranker: Option<Arc<dyn Reranker>>,
    pub token: Option<String>,
    pub oauth: Option<OAuth>,
    pub session_key: [u8; 32],
    pub clock: Clock,
}

pub fn router(app: Arc<App>) -> Router {
    let mut protected = Router::new()
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
        );
    if app.oauth.is_some() {
        protected = protected
            .route("/grants", get(grants))
            .route("/grants/{id}", axum::routing::delete(revoke_grant));
    }
    let protected = protected.route_layer(middleware::from_fn_with_state(app.clone(), api_auth));
    let mut api = Router::new()
        .route("/auth", get(auth_methods))
        .merge(protected)
        .route(
            "/logout",
            post(|headers: HeaderMap| async move {
                (
                    StatusCode::NO_CONTENT,
                    [(header::SET_COOKIE, session::clear(&headers))],
                )
            }),
        );
    if app.token.is_some() {
        api = api.route("/login", post(login));
    }
    let mcp = Router::new()
        .route("/mcp", post(mcp))
        .route_layer(middleware::from_fn_with_state(app.clone(), mcp_auth));
    let mut root = Router::new().merge(mcp).nest("/api", api);
    if app.oauth.is_some() {
        root = root.merge(oauth::routes());
    }
    root.fallback(asset).with_state(app)
}

async fn auth_methods(State(app): State<Arc<App>>) -> Json<Value> {
    let mut methods = Vec::new();
    if app.oauth.is_some() {
        methods.push("google");
    }
    if app.token.is_some() {
        methods.push("token");
    }
    Json(json!({ "methods": methods }))
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

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, token)| token.trim())
}

fn server_token(app: &App, token: &str) -> bool {
    app.token
        .as_deref()
        .is_some_and(|expected| bool::from(token.as_bytes().ct_eq(expected.as_bytes())))
}

/// Cookies only read, plus settings and grant revocation, which a cross-site page can't send
/// without CORS approval; so no web page can change memory through a signed-in browser.
async fn api_auth(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    let bearer = bearer(headers).is_some_and(|token| server_token(&app, token));
    let path = request.uri().path();
    let cookie_method = matches!(*request.method(), Method::GET | Method::HEAD)
        || (*request.method() == Method::PUT && path == "/settings")
        || (*request.method() == Method::DELETE
            && path
                .strip_prefix("/grants/")
                .is_some_and(|id| !id.is_empty() && !id.contains('/')));
    let subject = session::verify(
        &app.session_key,
        app.token.as_deref(),
        app.oauth.is_some(),
        headers,
        (app.clock)(),
    );
    let cookie = match subject {
        Some(Subject::Token) => true,
        Some(Subject::Email(email)) => app.oauth.as_ref().is_some_and(|oauth| oauth.allows(&email)),
        None => false,
    };
    if !(bearer || (cookie_method && cookie)) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn mcp_auth(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let bearer = bearer(request.headers());
    let mut authorized = bearer.is_some_and(|token| server_token(&app, token));
    if !authorized && let (Some(token), Some(oauth)) = (bearer, app.oauth.as_ref()) {
        authorized = oauth
            .valid_access(app.storage.as_ref(), token, (app.clock)())
            .await;
    }
    if !authorized {
        let Some(oauth) = app.oauth.as_ref() else {
            return StatusCode::UNAUTHORIZED.into_response();
        };
        let resource = format!(
            "{}/.well-known/oauth-protected-resource/mcp",
            oauth.public_url()
        );
        let challenge = if bearer.is_some() {
            format!("Bearer error=\"invalid_token\", resource_metadata=\"{resource}\"")
        } else {
            format!("Bearer resource_metadata=\"{resource}\"")
        };
        return (
            StatusCode::UNAUTHORIZED,
            [(
                header::WWW_AUTHENTICATE,
                HeaderValue::from_str(&challenge).expect("cannot create bearer challenge"),
            )],
        )
            .into_response();
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
    let Some(token) = app.token.as_deref() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !bool::from(body.token.trim().as_bytes().ct_eq(token.as_bytes())) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    (
        StatusCode::NO_CONTENT,
        [(
            header::SET_COOKIE,
            session::issue_token(&app.session_key, token, &headers, (app.clock)()),
        )],
    )
        .into_response()
}

async fn grants(State(app): State<Arc<App>>) -> Result<Json<Vec<Grant>>> {
    Ok(Json(app.storage.grants().await?))
}

async fn revoke_grant(State(app): State<Arc<App>>, Path(id): Path<String>) -> Response {
    match app.storage.revoke_grant(&id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => error.into_response(),
    }
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
            token: Some(token.into()),
            oauth: None,
            session_key: [0; 32],
            clock: Arc::new(|| 0),
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
            token: Some(token.clone()),
            oauth: None,
            session_key: [0; 32],
            clock: Arc::new(|| 0),
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
