mod config;
mod error;
mod markdown;
mod mcp;
mod rerank;
mod retrieval;
mod server;
mod storage;

use std::{
    fs,
    path::{Path, PathBuf},
    process::ExitCode,
    sync::Arc,
};

use clap::{Parser, Subcommand};
use tokio::signal::unix::{SignalKind, signal};

use crate::{
    config::Config,
    rerank::{Reranker, jev::Jev},
    server::App,
    storage::{Change, SqliteStorage, Storage},
};

type CliResult = Result<(), Box<dyn std::error::Error>>;

#[derive(Parser)]
#[command(version, about = "Pensieve shared agent memory server")]
struct Cli {
    /// TOML config file [default: ~/.config/pensieve/config.toml, optional]
    #[arg(short, long, env = "PENSIEVE_CONFIG")]
    config: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serve the HTTP API and web UI.
    Serve,
    /// Import `*.md` pages from a directory (e.g. an Obsidian LLM wiki). Skips index.md and log.md.
    Import { dir: PathBuf },
    /// Write every page to `<dir>/<title>.md`.
    Export { dir: PathBuf },
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("pensieve-server: {e}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> CliResult {
    let cli = Cli::parse();
    let config = Config::load(cli.config.as_deref())?;
    let db = &config.storage.path;
    if let Some(parent) = db.parent() {
        fs::create_dir_all(parent)?;
    }
    let storage =
        SqliteStorage::open(db).map_err(|e| format!("cannot open {}: {e}", db.display()))?;
    let storage: Arc<dyn Storage> = Arc::new(storage);
    match cli.command {
        Command::Serve => {
            let Config { server, jev, .. } = config;
            if server.token.len() < 16 {
                return Err(
                    "cannot start: server.token (or PENSIEVE_TOKEN) must be at least 16 characters"
                        .into(),
                );
            }
            let reranker = jev.key.filter(|key| !key.is_empty()).map(|key| {
                let (url, model) = jev.provider.preset();
                Arc::new(Jev::new(url, model, key)) as Arc<dyn Reranker>
            });
            let search = if reranker.is_some() {
                "BM25 + Jev"
            } else {
                "BM25"
            };
            eprintln!(
                "pensieve: db {} · search {search} · http://{}",
                db.display(),
                server.listen
            );
            let app = Arc::new(App {
                storage,
                reranker,
                token: server.token,
            });
            let listener = tokio::net::TcpListener::bind(server.listen).await?;
            // Explicit handlers: as PID 1 in a container, signals without one are ignored.
            let (mut interrupt, mut terminate) = (
                signal(SignalKind::interrupt())?,
                signal(SignalKind::terminate())?,
            );
            axum::serve(listener, server::router(app))
                .with_graceful_shutdown(async move {
                    tokio::select! {
                        _ = interrupt.recv() => {}
                        _ = terminate.recv() => {}
                    }
                })
                .await?;
        }
        Command::Import { dir } => import(storage.as_ref(), &dir).await?,
        Command::Export { dir } => export(storage.as_ref(), &dir).await?,
    }
    Ok(())
}

async fn import(storage: &dyn Storage, dir: &Path) -> CliResult {
    let (mut imported, mut unchanged) = (0, 0);
    let summary = format!(
        "Import from {}",
        dir.file_name().unwrap_or(dir.as_os_str()).to_string_lossy()
    );
    let change = Change {
        author: "import",
        summary: Some(&summary),
    };
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
        match storage.put(title, &content, None, change).await {
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
