# Pensieve

Persistent memory for agents, shared across devices. It follows the [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern: agents keep a Markdown wiki connected by `[[links]]`. Pages are stored in one SQLite database on a server instead of a folder that has to be synced between machines.

- `pensieve-server` stores pages in SQLite and keeps revision history and the link graph. It serves the HTTP API and a web UI for search, reading and a link-graph view.
- `pensieve` is a stdio MCP server that each agent runs locally. It forwards requests to `pensieve-server`.

Search uses SQLite FTS5 BM25. With a Jev key, the top 40 BM25 matches are sent to [Jev](https://vercel.com/ai-gateway/models/jev), which scores how relevant each page is. Pages it judges unlikely to help are dropped, as in [jevgrep](https://github.com/dzhng/jevgrep). If Jev fails, search falls back to BM25.

## Server

```sh
cargo build --release
export PENSIEVE_TOKEN="$(openssl rand -hex 32)"      # every client uses the same token
target/release/pensieve-server import ~/vaults/wiki   # optional, one-off; skips index.md and log.md
target/release/pensieve-server serve                  # http://127.0.0.1:7878
```

| Env | Default | |
|---|---|---|
| `PENSIEVE_TOKEN` | required | Bearer token for the API and web UI (at least 16 characters) |
| `PENSIEVE_DB` | `~/.local/share/pensieve/pensieve.db` | SQLite file |
| `PENSIEVE_LISTEN` | `127.0.0.1:7878` | |
| `PENSIEVE_JEV_KEY` | unset (BM25 only) | Key for the chosen provider |
| `PENSIEVE_JEV_PROVIDER` | `vercel` | `vercel`, `typesafe`, `openrouter` or `opencode` |

To reach the server from other devices, keep it bound to loopback and publish it on your tailnet with `tailscale serve --bg 7878`. `export <dir>` writes every page back out as `<title>.md`.

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
