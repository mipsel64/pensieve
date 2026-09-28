# Pensieve

Persistent memory for agents, shared across devices. It follows the [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern: agents keep a Markdown wiki connected by `[[links]]`. Pages are stored in one SQLite database on a server instead of a folder that has to be synced between machines.

- `pensieve-server` stores pages in SQLite and keeps revision history and the link graph. It serves the HTTP API and a web UI for search, reading and a link-graph view.
- `pensieve` is a stdio MCP server that each agent runs locally. It forwards requests to `pensieve-server`.

Search uses SQLite FTS5 BM25. With a Jev key, the top 40 BM25 matches are sent to [Jev](https://vercel.com/ai-gateway/models/jev), which scores how relevant each page is. Pages it judges unlikely to help are dropped, as in [jevgrep](https://github.com/dzhng/jevgrep). If Jev fails, search falls back to BM25.

## Server

Building needs Rust and Node 22.18 or newer. The web UI (React and Vite, in `server/web`) is compiled into `pensieve-server`, so run `make` once before `cargo build` or `cargo test`.

```sh
make setup      # installs pensieve-server and pensieve to ~/.local/bin and starts the service
```

On first run, `make setup` creates `~/.config/pensieve/environment` (mode 0600) with a random `PENSIEVE_TOKEN`. Every client needs this token. The service is a launchd daemon on macOS and a systemd user service on Linux; both read their settings from this file.

| Setting | Default | |
|---|---|---|
| `PENSIEVE_TOKEN` | generated | Bearer token for the API and web UI (at least 16 characters) |
| `PENSIEVE_DB` | `~/.local/share/pensieve/pensieve.db` | SQLite file |
| `PENSIEVE_LISTEN` | `127.0.0.1:7878` | |
| `PENSIEVE_JEV_KEY` | unset (BM25 only) | Key for the chosen provider |
| `PENSIEVE_JEV_PROVIDER` | `vercel` | `vercel`, `typesafe`, `openrouter` or `opencode` |

| Command | |
|---|---|
| `make` / `make install` | Build, or build and install both binaries. Client-only devices need just this |
| `make restart [REBUILD=1]` / `make status` | Restart the service (rebuild first with `REBUILD=1`) or show its state |
| `make clean` | Remove the service and binaries; keeps the config and database |

Import an existing wiki once with `pensieve-server import ~/vaults/wiki`; it skips `index.md` and `log.md`. `pensieve-server export <dir>` writes every page back out as `<title>.md`. To reach the server from other devices, keep it on loopback and run `tailscale serve --bg 7878`. On Linux, run `loginctl enable-linger` so the service keeps running after you log out.

New backends implement `storage::Storage` and must pass `storage::conformance::check`. New rerankers implement `rerank::Reranker`.

## Docker

The image contains only `pensieve-server` and runs as a non-root user. The database is stored in the `/var/lib/pensieve` volume.

```sh
docker build -t pensieve .
docker run --rm -v pensieve:/var/lib/pensieve -v ~/vaults/wiki:/wiki:ro pensieve import /wiki   # optional
docker run -d --name pensieve --restart unless-stopped \
  -p 127.0.0.1:7878:7878 -v pensieve:/var/lib/pensieve \
  --env-file ~/.config/pensieve/environment pensieve
```

The env file needs `PENSIEVE_TOKEN` and optionally the Jev settings. Leave `PENSIEVE_DB` and `PENSIEVE_LISTEN` unset; the image sets them. Keep the `127.0.0.1:` prefix on `-p`: without it, Docker publishes the port on every interface, and on Linux that bypasses the host firewall. Then run `tailscale serve --bg 7878` on the host as above.

## Agents

Use the same MCP entry on every device:

```sh
claude mcp add --scope user pensieve \
  -e PENSIEVE_URL=https://my-server.tailnet.ts.net -e PENSIEVE_TOKEN=... -- /path/to/pensieve
```

```toml
# ~/.codex/config.toml
[mcp_servers.pensieve]
command = "/path/to/pensieve"
env = { PENSIEVE_URL = "https://my-server.tailnet.ts.net", PENSIEVE_TOKEN = "..." }
```

Tools:

- `search`: find pages by query.
- `read`: return a page with its rev, links and backlinks.
- `write`: create a page or replace one. Replacing needs `base_rev`, so a stale write from one device can't overwrite a newer change from another.
- `edit`: replace one exact snippet.

Each write is recorded with the agent and host that made it. The content of a page titled `AGENTS` is appended to the MCP server instructions, so the wiki schema is sent to every agent that connects.
