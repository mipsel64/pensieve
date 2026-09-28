use std::{
    fmt::Write as _,
    fs,
    io::{self, BufRead, Write},
    process::Command,
    time::Duration,
};

use reqwest::{Method, Url, blocking::Client};
use serde_json::{Value, json};

const PROTOCOLS: [&str; 4] = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const DEFAULT_PROTOCOL: &str = "2025-06-18";
/// A page with this title is appended to the MCP instructions, so conventions travel with the memory.
const SCHEMA_PAGE: &str = "AGENTS";
const INSTRUCTIONS: &str = "Pensieve is a persistent memory wiki shared across devices and agents. \
Search it before answering anything that may depend on past decisions, preferences, projects, incidents or runbooks, \
then read the relevant pages. Pages are Markdown; link related pages with [[Page Title]]: links form the knowledge graph \
and backlinks are computed automatically. Use `edit` for small changes; `write` replaces a whole page and needs the \
`base_rev` returned by `read`.";

struct Pensieve {
    http: Client,
    base: Url,
    token: String,
    host: String,
    agent: String,
}

fn main() {
    let url = std::env::var("PENSIEVE_URL").unwrap_or_else(|_| "http://127.0.0.1:7878".into());
    let base = match Url::parse(&url) {
        Ok(base) if !base.cannot_be_a_base() => base,
        _ => {
            eprintln!("pensieve: invalid PENSIEVE_URL {url:?}");
            std::process::exit(2);
        }
    };
    let http = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(60))
        .build()
        .expect("tls backend");
    let token = std::env::var("PENSIEVE_TOKEN").unwrap_or_default();
    let host = hostname();
    let mut pensieve = Pensieve {
        http,
        base,
        token,
        agent: format!("mcp@{host}"),
        host,
    };

    let mut stdout = io::stdout().lock();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(message) => {
                // Notifications and responses carry no request to answer.
                let Some(id) = message
                    .get("id")
                    .filter(|_| message.get("result").or(message.get("error")).is_none())
                else {
                    continue;
                };
                let result = match message["method"].as_str() {
                    Some(method) => pensieve.handle(method, &message["params"]),
                    None => Err((-32600, "invalid request: missing method".into())),
                };
                match result {
                    Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                    Err((code, message)) => {
                        json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
                    }
                }
            }
            Err(_) if line.trim().is_empty() => continue,
            Err(e) => {
                json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": e.to_string() } })
            }
        };
        if writeln!(stdout, "{reply}")
            .and_then(|()| stdout.flush())
            .is_err()
        {
            break;
        }
    }
}

impl Pensieve {
    fn handle(&mut self, method: &str, params: &Value) -> Result<Value, (i64, String)> {
        match method {
            "initialize" => {
                let requested = params["protocolVersion"].as_str().unwrap_or_default();
                let version = PROTOCOLS
                    .into_iter()
                    .find(|v| *v == requested)
                    .unwrap_or(DEFAULT_PROTOCOL);
                if let Some(name) = params["clientInfo"]["name"].as_str() {
                    self.agent = format!("{name}@{}", self.host);
                }
                Ok(json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "pensieve", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": self.instructions(),
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tools() })),
            "tools/call" => {
                let args = &params["arguments"];
                let result = match params["name"].as_str().unwrap_or_default() {
                    "search" => self.search(args),
                    "read" => self.read(args),
                    "write" => self.write(args),
                    "edit" => self.edit(args),
                    name => return Err((-32602, format!("unknown tool: {name}"))),
                };
                let (text, is_error) = match result {
                    Ok(text) => (text, false),
                    Err(text) => (text, true),
                };
                Ok(json!({ "content": [{ "type": "text", "text": text }], "isError": is_error }))
            }
            _ => Err((-32601, format!("method not found: {method}"))),
        }
    }

    fn instructions(&self) -> String {
        match self.call(Method::GET, &["api", "pages", SCHEMA_PAGE], &[], None) {
            Ok(page) => format!(
                "{INSTRUCTIONS}\n\n{}",
                page["content"].as_str().unwrap_or_default()
            ),
            Err(_) => INSTRUCTIONS.into(),
        }
    }

    fn search(&self, args: &Value) -> Result<String, String> {
        let query = args["query"].as_str().unwrap_or_default();
        let limit = args["limit"].as_u64().unwrap_or(10).to_string();
        let res = self.call(
            Method::GET,
            &["api", "search"],
            &[("q", query), ("limit", &limit)],
            None,
        )?;
        let hits = res["hits"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        if hits.is_empty() {
            return Ok("No relevant pages.".into());
        }
        let mut out = String::from(if res["reranked"] == true {
            "Ranked by Jev relevance probability:\n"
        } else {
            "Ranked by BM25:\n"
        });
        for hit in hits {
            let snippet = hit["snippet"]
                .as_str()
                .unwrap_or_default()
                .replace('\n', " ");
            let _ = writeln!(
                out,
                "- {} (rev {}, updated {}, score {:.2})\n  {snippet}",
                hit["title"].as_str().unwrap_or_default(),
                hit["rev"],
                hit["updated_at"].as_str().unwrap_or_default(),
                hit["score"].as_f64().unwrap_or_default(),
            );
        }
        Ok(out)
    }

    fn read(&self, args: &Value) -> Result<String, String> {
        let page = self.call(
            Method::GET,
            &["api", "pages", required(args, "title")?],
            &[],
            None,
        )?;
        let links: Vec<_> = page["links"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|l| {
                let title = l["title"].as_str().unwrap_or_default();
                if l["exists"] == true {
                    title.to_owned()
                } else {
                    format!("{title} (missing)")
                }
            })
            .collect();
        let backlinks: Vec<_> = page["backlinks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        Ok(format!(
            "# {}\nrev {} · updated {} by {}\nLinks: {}\nBacklinks: {}\n\n{}",
            page["title"].as_str().unwrap_or_default(),
            page["rev"],
            page["updated_at"].as_str().unwrap_or_default(),
            page["updated_by"].as_str().unwrap_or_default(),
            links.join(", "),
            backlinks.join(", "),
            page["content"].as_str().unwrap_or_default(),
        ))
    }

    fn write(&self, args: &Value) -> Result<String, String> {
        let title = required(args, "title")?;
        let body =
            json!({ "content": required(args, "content")?, "base_rev": args["base_rev"].as_i64() });
        let res = self.call(Method::PUT, &["api", "pages", title], &[], Some(body))?;
        Ok(format!("Saved {title} (rev {})", res["rev"]))
    }

    fn edit(&self, args: &Value) -> Result<String, String> {
        let title = required(args, "title")?;
        let body = json!({ "old_text": required(args, "old_text")?, "new_text": required(args, "new_text")? });
        let res = self.call(
            Method::POST,
            &["api", "pages", title, "edit"],
            &[],
            Some(body),
        )?;
        Ok(format!("Edited {title} (rev {})", res["rev"]))
    }

    fn call(
        &self,
        method: Method,
        path: &[&str],
        query: &[(&str, &str)],
        body: Option<Value>,
    ) -> Result<Value, String> {
        let mut url = self.base.clone();
        url.path_segments_mut()
            .expect("checked at startup")
            .pop_if_empty()
            .extend(path);
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        let mut request = self
            .http
            .request(method, url)
            .bearer_auth(&self.token)
            .header("x-pensieve-agent", &self.agent);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .map_err(|e| format!("pensieve server unreachable: {e}"))?;
        let status = response.status();
        let text = response.text().map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("{status}: {text}"));
        }
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }
}

fn required<'a>(args: &'a Value, name: &str) -> Result<&'a str, String> {
    args[name]
        .as_str()
        .ok_or_else(|| format!("missing string argument `{name}`"))
}

fn tools() -> Value {
    let read_only = json!({ "readOnlyHint": true });
    json!([
        {
            "name": "search",
            "description": "Search memory pages by relevance. Returns titles, revs, snippets and scores. An empty query lists recently updated pages.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Natural-language question or keywords." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 }
                },
                "required": ["query"]
            },
            "annotations": read_only
        },
        {
            "name": "read",
            "description": "Read a page: full Markdown, rev, outgoing links and backlinks.",
            "inputSchema": {
                "type": "object",
                "properties": { "title": { "type": "string" } },
                "required": ["title"]
            },
            "annotations": read_only
        },
        {
            "name": "write",
            "description": "Create a page, or replace a page's full Markdown. Replacing an existing page requires base_rev (the rev from read), so changes made from another device are never overwritten silently. Link pages with [[Page Title]].",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "content": { "type": "string", "description": "Full Markdown, including any frontmatter." },
                    "base_rev": { "type": "integer", "description": "Current rev of the page; omit when creating." }
                },
                "required": ["title", "content"]
            }
        },
        {
            "name": "edit",
            "description": "Replace one exact occurrence of old_text with new_text in a page. old_text must match exactly once. Prefer this over write for small changes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "old_text": { "type": "string" },
                    "new_text": { "type": "string" }
                },
                "required": ["title", "old_text", "new_text"]
            }
        }
    ])
}

fn hostname() -> String {
    let from_command = Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok());
    from_command
        .or_else(|| fs::read_to_string("/etc/hostname").ok())
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "unknown".into())
}
