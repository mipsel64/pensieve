mod config;
mod error;
mod markdown;
mod mcp;
mod rerank;
mod retrieval;
mod server;
mod session;
mod storage;

use std::{
    collections::HashMap,
    fs,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
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
    create_private(db)?;
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

/// Creates the database's directory (0700) and file (0600) if missing, so page content isn't
/// readable by other local users; SQLite gives its WAL files the database file's mode.
fn create_private(db: &Path) -> std::io::Result<()> {
    if let Some(parent) = db.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
    }
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(db)
    {
        Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => Err(e),
        Err(_) => {
            // Existing files keep their mode: it may be deliberate, so warn rather than change it.
            let mode = fs::metadata(db)?.permissions().mode();
            if mode & 0o077 != 0 {
                eprintln!(
                    "pensieve-server: warning: {} is readable by other users (mode {:o}); run chmod 600 on it",
                    db.display(),
                    mode & 0o777
                );
            }
            Ok(())
        }
        Ok(_) => Ok(()),
    }
}

async fn import(storage: &dyn Storage, dir: &Path) -> CliResult {
    let (mut imported, mut unchanged, mut failed) = (0, 0, 0);
    let mut seen: HashMap<String, PathBuf> = HashMap::new();
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
        // Titles are trimmed and case-insensitive, so Foo.md, foo.md and "Foo .md" are one page.
        let key = title.trim().to_ascii_lowercase();
        if let Some(first) = seen.get(&key) {
            eprintln!("skip {}: same title as {}", path.display(), first.display());
            failed += 1;
            continue;
        }
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(e) => {
                eprintln!("skip {}: {e}", path.display());
                failed += 1;
                continue;
            }
        };
        let before = storage.page(title).await.map(|p| p.rev).ok();
        let saved = storage.put(title, &content, None, change).await;
        if saved.is_ok() {
            seen.insert(key, path.clone());
        }
        match saved {
            Ok(rev) if Some(rev) == before => unchanged += 1,
            Ok(_) => imported += 1,
            Err(e) => {
                eprintln!("skip {}: {e}", path.display());
                failed += 1;
            }
        }
    }
    eprintln!("imported {imported}, unchanged {unchanged}, failed {failed}");
    if failed > 0 {
        return Err(format!("{failed} files were not imported").into());
    }
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
