//! Stdio MCP server that forwards JSON-RPC to `pensieve-server`, which implements the tools.

use std::{
    fs,
    io::{self, BufRead, Write},
    process::Command,
    time::Duration,
};

use reqwest::{StatusCode, Url, blocking::Client};
use serde_json::{Value, json};

fn main() {
    let url = std::env::var("PENSIEVE_URL").unwrap_or_else(|_| "http://127.0.0.1:7878".into());
    let mut endpoint = match Url::parse(&url) {
        Ok(url) if !url.cannot_be_a_base() => url,
        _ => {
            eprintln!("pensieve: invalid PENSIEVE_URL {url:?}");
            std::process::exit(2);
        }
    };
    endpoint
        .path_segments_mut()
        .expect("checked above")
        .pop_if_empty()
        .extend(["api", "mcp"]);
    let http = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(60))
        .build()
        .expect("internal error: cannot build HTTP client");
    let token = std::env::var("PENSIEVE_TOKEN").unwrap_or_default();
    let host = hostname();
    let mut agent = format!("mcp@{host}");

    let mut stdout = io::stdout().lock();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let message: Value = match serde_json::from_str(&line) {
            Ok(message) => message,
            Err(e) => {
                let reply = json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": e.to_string() } });
                if writeln!(stdout, "{reply}")
                    .and_then(|()| stdout.flush())
                    .is_err()
                {
                    break;
                }
                continue;
            }
        };
        if message["method"] == "initialize"
            && let Some(name) = message["params"]["clientInfo"]["name"].as_str()
        {
            agent = format!("{name}@{host}");
        }
        let request = http
            .post(endpoint.clone())
            .bearer_auth(&token)
            .header("x-pensieve-agent", &agent)
            .json(&message);
        let reply = match request.send().and_then(|r| Ok((r.status(), r.text()?))) {
            Ok((StatusCode::ACCEPTED, _)) => continue,
            Ok((status, body)) if status.is_success() => match serde_json::from_str::<Value>(&body)
            {
                Ok(reply) => reply,
                Err(e) => failure(&message, format!("invalid reply from pensieve-server: {e}")),
            },
            Ok((status, body)) => failure(
                &message,
                format!("pensieve-server returned {status}: {}", body.trim()),
            ),
            Err(e) => failure(&message, format!("pensieve server unreachable: {e}")),
        };
        // Notifications get no reply, even when forwarding them failed.
        if message.get("id").is_none() {
            continue;
        }
        if writeln!(stdout, "{reply}")
            .and_then(|()| stdout.flush())
            .is_err()
        {
            break;
        }
    }
}

fn failure(message: &Value, reason: String) -> Value {
    json!({ "jsonrpc": "2.0", "id": message["id"], "error": { "code": -32000, "message": reason } })
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
