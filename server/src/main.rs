mod error;
mod rerank;
mod server;
mod storage;

use std::{
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

use clap::{Parser, Subcommand};

use crate::{
    rerank::{
        Reranker,
        jev::{Jev, Provider},
    },
    server::App,
    storage::{SqliteStorage, Storage},
};

type CliResult = Result<(), Box<dyn std::error::Error>>;

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
        jev_provider: Provider,
        /// Enables Jev reranking; without it search is BM25 only.
        #[arg(long, env = "PENSIEVE_JEV_KEY", hide_env_values = true)]
        jev_key: Option<String>,
    },
    /// Import `*.md` pages from a directory (e.g. an Obsidian LLM wiki). Skips index.md and log.md.
    Import { dir: PathBuf },
    /// Write every page to `<dir>/<title>.md`.
    Export { dir: PathBuf },
}

#[tokio::main]
async fn main() -> CliResult {
    let cli = Cli::parse();
    if let Some(parent) = cli.db.parent() {
        fs::create_dir_all(parent)?;
    }
    let storage = SqliteStorage::open(&cli.db)
        .map_err(|e| format!("cannot open {}: {e}", cli.db.display()))?;
    let storage: Arc<dyn Storage> = Arc::new(storage);
    match cli.command {
        Command::Serve {
            listen,
            token,
            jev_provider,
            jev_key,
        } => {
            if token.len() < 16 {
                return Err("cannot start: PENSIEVE_TOKEN must be at least 16 characters".into());
            }
            let reranker = jev_key.map(|key| {
                let (url, model) = jev_provider.preset();
                Arc::new(Jev::new(url, model, key)) as Arc<dyn Reranker>
            });
            let search = if reranker.is_some() {
                "BM25 + Jev"
            } else {
                "BM25"
            };
            eprintln!(
                "pensieve: db {} · search {search} · http://{listen}",
                cli.db.display()
            );
            let app = Arc::new(App {
                storage,
                reranker,
                token,
            });
            let listener = tokio::net::TcpListener::bind(listen).await?;
            axum::serve(listener, server::router(app)).await?;
        }
        Command::Import { dir } => import(storage.as_ref(), &dir).await?,
        Command::Export { dir } => export(storage.as_ref(), &dir).await?,
    }
    Ok(())
}

async fn import(storage: &dyn Storage, dir: &Path) -> CliResult {
    let (mut imported, mut unchanged) = (0, 0);
    for entry in fs::read_dir(dir)? {
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
        let before = storage.page(title).await.map(|p| p.rev).ok();
        match storage.put(title, &content, None, "import").await {
            Ok(rev) if Some(rev) == before => unchanged += 1,
            Ok(_) => imported += 1,
            Err(e) => eprintln!("skip {}: {e}", path.display()),
        }
    }
    eprintln!("imported {imported}, unchanged {unchanged}");
    Ok(())
}

async fn export(storage: &dyn Storage, dir: &Path) -> CliResult {
    fs::create_dir_all(dir)?;
    let pages = storage.pages().await?;
    for (title, content) in &pages {
        fs::write(dir.join(format!("{title}.md")), content)?;
    }
    eprintln!("exported {} pages to {}", pages.len(), dir.display());
    Ok(())
}

fn default_db() -> PathBuf {
    std::env::home_dir()
        .unwrap_or_default()
        .join(".local/share/pensieve/pensieve.db")
}
