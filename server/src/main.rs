mod jev;
mod store;

use std::{
    fs,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
};

use axum::{
    Json, Router,
    extract::{Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use clap::{Parser, Subcommand};
use serde::Deserialize;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;

use crate::{jev::Jev, store::Store};

/// Candidate pool handed to Jev; recall is bounded by BM25 at this depth.
const CANDIDATES: usize = 40;
const CSP: &str = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'";

#[derive(Parser)]
#[command(version, about = "Pensieve shared agent memory server")]
struct Cli {
    /// SQLite database file.
    #[arg(long, env = "PENSIEVE_DB", default_value_os_t = default_db())]
    db: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serve the HTTP API and web UI.
    Serve {
        #[arg(long, env = "PENSIEVE_LISTEN", default_value = "127.0.0.1:7878")]
        listen: SocketAddr,
        /// Bearer token required by the API (at least 16 characters).
        #[arg(long, env = "PENSIEVE_TOKEN", hide_env_values = true)]
        token: String,
        #[arg(
            long,
            env = "PENSIEVE_JEV_PROVIDER",
            value_enum,
            default_value = "vercel"
        )]
        jev_provider: jev::Provider,
        /// Enables Jev reranking; without it search is BM25 only.
        #[arg(long, env = "PENSIEVE_JEV_KEY", hide_env_values = true)]
        jev_key: Option<String>,
    },
    /// Import `*.md` pages from a directory (e.g. an Obsidian LLM wiki). Skips index.md and log.md.
    Import { dir: PathBuf },
    /// Write every page to `<dir>/<title>.md`.
    Export { dir: PathBuf },
}

struct App {
    store: Mutex<Store>,
    token: String,
    jev: Option<Jev>,
}

impl App {
    // ponytail: one connection behind a global lock; a connection pool if write volume ever matters.
    fn store(&self) -> MutexGuard<'_, Store> {
        self.store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    if let Some(parent) = cli.db.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut store =
        Store::open(&cli.db).map_err(|e| format!("open {}: {e:?}", cli.db.display()))?;
    match cli.command {
        Command::Serve {
            listen,
            token,
            jev_provider,
            jev_key,
        } => {
            if token.len() < 16 {
                return Err("PENSIEVE_TOKEN must be at least 16 characters".into());
            }
            let jev = jev_key.map(|key| {
                let (url, model) = jev_provider.preset();
                Jev::new(url, model, key)
            });
            eprintln!(
                "pensieve: db {} · search {} · http://{listen}",
                cli.db.display(),
                if jev.is_some() { "BM25 + Jev" } else { "BM25" }
            );
            let app = Arc::new(App {
                store: Mutex::new(store),
                token,
                jev,
            });
            let listener = tokio::net::TcpListener::bind(listen).await?;
            axum::serve(listener, router(app)).await?;
        }
        Command::Import { dir } => {
            let (mut imported, mut unchanged) = (0, 0);
            for entry in fs::read_dir(&dir)? {
                let path = entry?.path();
                let (Some(title), Some("md")) = (
                    path.file_stem().and_then(|s| s.to_str()),
                    path.extension().and_then(|s| s.to_str()),
                ) else {
                    continue;
                };
                if ["index", "log"]
                    .iter()
                    .any(|skip| title.eq_ignore_ascii_case(skip))
                {
                    continue;
                }
                let Ok(content) = fs::read_to_string(&path) else {
                    eprintln!("skip {}: not UTF-8", path.display());
                    continue;
                };
                let before = store.page(title).map(|p| p.rev).ok();
                match store.put(title, &content, None, "import") {
                    Ok(rev) if Some(rev) == before => unchanged += 1,
                    Ok(_) => imported += 1,
                    Err(e) => eprintln!("skip {}: {e:?}", path.display()),
                }
            }
            eprintln!("imported {imported}, unchanged {unchanged}");
        }
        Command::Export { dir } => {
            fs::create_dir_all(&dir)?;
            let pages = store.all().map_err(|e| format!("{e:?}"))?;
            for (title, content) in &pages {
                fs::write(dir.join(format!("{title}.md")), content)?;
            }
            eprintln!("exported {} pages to {}", pages.len(), dir.display());
        }
    }
    Ok(())
}

fn router(app: Arc<App>) -> Router {
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
) -> Result<Json<Value>, store::Error> {
    let limit = params.limit.unwrap_or(10).clamp(1, 50);
    let jev = app
        .jev
        .as_ref()
        .filter(|_| params.rerank.unwrap_or(true) && !params.q.trim().is_empty());
    let mut hits = app.store().search(
        &params.q,
        if jev.is_some() {
            CANDIDATES.max(limit)
        } else {
            limit
        },
    )?;
    if let Some(jev) = jev {
        match jev.rerank(&params.q, &hits, limit).await {
            Ok(ranked) => return Ok(Json(json!({ "reranked": true, "hits": ranked }))),
            Err(e) => eprintln!("jev rerank failed, falling back to BM25: {e}"),
        }
    }
    hits.truncate(limit);
    Ok(Json(json!({ "reranked": false, "hits": hits })))
}

async fn graph(State(app): State<Arc<App>>) -> Result<Json<store::Graph>, store::Error> {
    Ok(Json(app.store().graph()?))
}

async fn read(
    State(app): State<Arc<App>>,
    Path(title): Path<String>,
) -> Result<Json<store::Page>, store::Error> {
    Ok(Json(app.store().page(&title)?))
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
) -> Result<Json<Value>, store::Error> {
    let rev = app.store().put(
        &title,
        &body.content,
        Some(body.base_rev.unwrap_or(0)),
        &agent(&headers),
    )?;
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
) -> Result<Json<Value>, store::Error> {
    let rev = app
        .store()
        .edit(&title, &body.old_text, &body.new_text, &agent(&headers))?;
    Ok(Json(json!({ "title": title, "rev": rev })))
}

fn agent(headers: &HeaderMap) -> String {
    let agent = headers
        .get("x-pensieve-agent")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown");
    agent.chars().take(64).collect()
}

impl IntoResponse for store::Error {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::NotFound => (StatusCode::NOT_FOUND, "page not found".to_owned()),
            Self::Conflict(rev) => (
                StatusCode::CONFLICT,
                format!("page is at rev {rev}; read it again and retry with base_rev {rev}"),
            ),
            Self::Invalid(message) => (StatusCode::UNPROCESSABLE_ENTITY, message.to_owned()),
            Self::Db(error) => {
                eprintln!("database error: {error}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "database error".to_owned(),
                )
            }
        };
        (status, message).into_response()
    }
}

fn default_db() -> PathBuf {
    std::env::home_dir()
        .unwrap_or_default()
        .join(".local/share/pensieve/pensieve.db")
}
