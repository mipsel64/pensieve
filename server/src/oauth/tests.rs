use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, AtomicUsize, Ordering},
    },
};

use axum::{Json, Router, extract::State, routing::post};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::{Client, Response, StatusCode, header};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use url::Url;

use super::*;
use crate::{
    config::{AuthMode, Config},
    server::{App, Clock, router},
    storage::SqliteStorage,
};

const PUBLIC_URL: &str = "https://pensieve.test";
const SERVER_TOKEN: &str = "test-token-0123456789";
const GOOGLE_CLIENT_ID: &str = "google-client";
const EMAIL: &str = "user@example.com";
const OTHER_EMAIL: &str = "other@example.com";
const VERIFIER: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const WRONG_VERIFIER: &str = "~._-9876543210ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvutsrqponmlkjihgfedcba";
const VALID_OAUTH: &str = r#"[oauth]
public_url = "https://pensieve.test"
google_client_id = "google-client"
google_client_secret = "google-secret"
allowed_emails = ["user@example.com"]
"#;

#[derive(Clone)]
struct MockGoogle {
    token_url: String,
    claims: Arc<Mutex<Value>>,
    calls: Arc<AtomicUsize>,
}

#[derive(Clone)]
struct MockGoogleState {
    claims: Arc<Mutex<Value>>,
    calls: Arc<AtomicUsize>,
}

impl MockGoogle {
    async fn start() -> Self {
        let claims = Arc::new(Mutex::new(json!({})));
        let calls = Arc::new(AtomicUsize::new(0));
        let state = MockGoogleState {
            claims: Arc::clone(&claims),
            calls: Arc::clone(&calls),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let token_url = format!("http://{}/token", listener.local_addr().unwrap());
        let app = Router::new()
            .route("/token", post(google_token))
            .with_state(state);
        tokio::spawn(axum::serve(listener, app).into_future());
        Self {
            token_url,
            claims,
            calls,
        }
    }

    fn prepare(&self, server: &TestServer, start: &GoogleStart, email: &str) {
        *self.claims.lock().unwrap() = json!({
            "iss": "https://accounts.google.com",
            "aud": GOOGLE_CLIENT_ID,
            "exp": server.now() + 600,
            "nonce": start.nonce,
            "sub": "google-subject",
            "email": email,
            "email_verified": true,
        });
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

async fn google_token(State(mock): State<MockGoogleState>) -> Json<Value> {
    mock.calls.fetch_add(1, Ordering::SeqCst);
    let claims = URL_SAFE_NO_PAD.encode(mock.claims.lock().unwrap().to_string());
    Json(json!({
        "id_token": format!("{}.{}.signature", URL_SAFE_NO_PAD.encode(r#"{"alg":"none"}"#), claims),
    }))
}

struct TestServer {
    root: String,
    public_url: String,
    http: Client,
    storage: Arc<SqliteStorage>,
    session_key: [u8; 32],
    clock: Arc<AtomicI64>,
    mock: MockGoogle,
}

impl TestServer {
    async fn spawn(mode: AuthMode) -> Self {
        Self::spawn_with(mode, PUBLIC_URL, vec![EMAIL.into(), OTHER_EMAIL.into()]).await
    }

    async fn spawn_with(mode: AuthMode, public_url: &str, allowed_emails: Vec<String>) -> Self {
        let storage = Arc::new(SqliteStorage::open(Path::new(":memory:")).unwrap());
        let clock = Arc::new(AtomicI64::new(1_700_000_000));
        let mock = MockGoogle::start().await;
        Self::spawn_parts(
            mode,
            public_url,
            allowed_emails,
            storage,
            [7; 32],
            clock,
            mock,
        )
        .await
    }

    async fn spawn_parts(
        mode: AuthMode,
        public_url: &str,
        allowed_emails: Vec<String>,
        storage: Arc<SqliteStorage>,
        session_key: [u8; 32],
        clock: Arc<AtomicI64>,
        mock: MockGoogle,
    ) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let mut google = Google::new(GOOGLE_CLIENT_ID, "google-secret");
        google.token_url = mock.token_url.clone();
        let app_clock = Arc::clone(&clock);
        let clock_fn: Clock = Arc::new(move || app_clock.load(Ordering::SeqCst));
        let app = Arc::new(App {
            storage: storage.clone(),
            reranker: None,
            token: mode.token().then(|| SERVER_TOKEN.into()),
            oauth: mode
                .oauth()
                .then(|| OAuth::new(public_url, google, allowed_emails)),
            session_key,
            clock: clock_fn,
        });
        tokio::spawn(axum::serve(listener, router(app)).into_future());
        let http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        Self {
            root,
            public_url: public_url.trim_end_matches('/').into(),
            http,
            storage,
            session_key,
            clock,
            mock,
        }
    }

    async fn restart(&self, public_url: &str, allowed_emails: Vec<String>) -> Self {
        Self::spawn_parts(
            AuthMode::OAuth,
            public_url,
            allowed_emails,
            Arc::clone(&self.storage),
            self.session_key,
            Arc::clone(&self.clock),
            self.mock.clone(),
        )
        .await
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.root)
    }

    fn now(&self) -> i64 {
        self.clock.load(Ordering::SeqCst)
    }

    fn advance(&self, seconds: i64) {
        self.clock.fetch_add(seconds, Ordering::SeqCst);
    }

    async fn mcp(&self, bearer: Option<&str>, message: Value) -> Response {
        let request = self.http.post(self.url("/mcp")).json(&message);
        let request = match bearer {
            Some(token) => request.bearer_auth(token),
            None => request,
        };
        request.send().await.unwrap()
    }
}

struct GoogleStart {
    state: String,
    nonce: String,
    state_cookie: String,
}

async fn start_google(server: &TestServer, next: Option<&str>) -> GoogleStart {
    let request = server.http.get(server.url("/auth/login"));
    let request = match next {
        Some(next) => request.query(&[("next", next)]),
        None => request,
    };
    let response = request.send().await.unwrap();
    assert_eq!(response.status(), StatusCode::FOUND);
    let state_cookie = cookie(&response, "pensieve_oauth_state");
    let location = Url::parse(&location(&response)).unwrap();
    let parameters: HashMap<_, _> = location.query_pairs().into_owned().collect();
    GoogleStart {
        state: parameters["state"].clone(),
        nonce: parameters["nonce"].clone(),
        state_cookie,
    }
}

async fn google_callback(
    server: &TestServer,
    start: &GoogleStart,
    state: &str,
    code: Option<&str>,
) -> Response {
    let mut url = Url::parse(&server.url("/auth/callback")).unwrap();
    url.query_pairs_mut().append_pair("state", state);
    if let Some(code) = code {
        url.query_pairs_mut().append_pair("code", code);
    }
    server
        .http
        .get(url)
        .header(header::COOKIE, &start.state_cookie)
        .send()
        .await
        .unwrap()
}

async fn google_sign_in(server: &TestServer) -> String {
    let start = start_google(server, None).await;
    server.mock.prepare(server, &start, EMAIL);
    let response = google_callback(server, &start, &start.state, Some("google-code")).await;
    assert_eq!(response.status(), StatusCode::FOUND);
    assert_eq!(location(&response), "/");
    cookie(&response, "pensieve_session")
}

fn cookie(response: &Response, name: &str) -> String {
    response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter(|value| value.starts_with(&format!("{name}=")))
        .find_map(|value| value.split(';').next())
        .unwrap_or_else(|| panic!("missing {name} cookie"))
        .to_owned()
}

fn set_cookie(response: &Response, name: &str) -> String {
    response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find(|value| value.starts_with(&format!("{name}=")))
        .unwrap_or_else(|| panic!("missing {name} cookie"))
        .to_owned()
}

fn location(response: &Response) -> String {
    response.headers()[header::LOCATION]
        .to_str()
        .unwrap()
        .to_owned()
}

fn redirect_url(response: &Response) -> Url {
    Url::parse(&location(response)).unwrap()
}

fn query_parameters(url: &Url) -> HashMap<String, String> {
    url.query_pairs().into_owned().collect()
}

struct RegisteredClient {
    id: String,
    name: String,
    redirect_uri: String,
}

async fn register(server: &TestServer, name: &str, redirect_uri: &str) -> RegisteredClient {
    let response = server
        .http
        .post(server.url("/register"))
        .json(&json!({ "client_name": name, "redirect_uris": [redirect_uri] }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let body: Value = response.json().await.unwrap();
    RegisteredClient {
        id: body["client_id"].as_str().unwrap().into(),
        name: body["client_name"].as_str().unwrap().into(),
        redirect_uri: body["redirect_uris"][0].as_str().unwrap().into(),
    }
}

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn authorize_url(
    server: &TestServer,
    client: &RegisteredClient,
    redirect_uri: &str,
    state: &str,
    with_pkce: bool,
    resource: &str,
) -> Url {
    let mut url = Url::parse(&server.url("/authorize")).unwrap();
    let mut query = url.query_pairs_mut();
    query
        .append_pair("client_id", &client.id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("state", state)
        .append_pair("resource", resource);
    if with_pkce {
        query
            .append_pair("code_challenge", &challenge(VERIFIER))
            .append_pair("code_challenge_method", "S256");
    }
    drop(query);
    url
}

fn handle(html: &str) -> String {
    let marker = "name=\"handle\" value=\"";
    html.split_once(marker)
        .unwrap()
        .1
        .split_once('"')
        .unwrap()
        .0
        .to_owned()
}

async fn consent(
    server: &TestServer,
    session: &str,
    client: &RegisteredClient,
    redirect_uri: &str,
    state: &str,
) -> (String, String) {
    let response = server
        .http
        .get(authorize_url(
            server,
            client,
            redirect_uri,
            state,
            true,
            &format!("{}/mcp", server.public_url),
        ))
        .header(header::COOKIE, session)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let html = response.text().await.unwrap();
    let handle = handle(&html);
    (handle, html)
}

async fn post_consent(
    server: &TestServer,
    session: &str,
    handle: &str,
    decision: &str,
    origin: Option<&str>,
) -> Response {
    let request = server
        .http
        .post(server.url("/authorize"))
        .header(header::COOKIE, session)
        .form(&[("handle", handle), ("decision", decision)]);
    let request = match origin {
        Some(origin) => request.header(header::ORIGIN, origin),
        None => request,
    };
    request.send().await.unwrap()
}

async fn authorization_code(
    server: &TestServer,
    session: &str,
    client: &RegisteredClient,
) -> String {
    let (handle, _) = consent(
        server,
        session,
        client,
        &client.redirect_uri,
        "client-state",
    )
    .await;
    let response = post_consent(
        server,
        session,
        &handle,
        "approve",
        Some(&server.public_url),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FOUND);
    let parameters = query_parameters(&redirect_url(&response));
    assert_eq!(parameters["state"], "client-state");
    assert_eq!(parameters["iss"], server.public_url);
    parameters["code"].clone()
}

#[derive(Clone)]
struct TokenBundle {
    client_id: String,
    access_token: String,
    refresh_token: String,
    cache_control: String,
}

async fn exchange_code(
    server: &TestServer,
    client_id: &str,
    code: &str,
    verifier: &str,
    redirect_uri: Option<&str>,
    basic: bool,
) -> Response {
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("code_verifier", verifier),
    ];
    if !basic {
        form.push(("client_id", client_id));
    }
    if let Some(redirect_uri) = redirect_uri {
        form.push(("redirect_uri", redirect_uri));
    }
    let request = server.http.post(server.url("/token")).form(&form);
    let request = if basic {
        request.basic_auth(client_id, Option::<&str>::None)
    } else {
        request
    };
    request.send().await.unwrap()
}

async fn token_bundle(response: Response, client_id: &str) -> TokenBundle {
    assert_eq!(response.status(), StatusCode::OK);
    let cache_control = response.headers()[header::CACHE_CONTROL]
        .to_str()
        .unwrap()
        .to_owned();
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["token_type"], "Bearer");
    assert_eq!(body["expires_in"], 3600);
    assert_eq!(body["scope"], "pensieve");
    TokenBundle {
        client_id: client_id.into(),
        access_token: body["access_token"].as_str().unwrap().into(),
        refresh_token: body["refresh_token"].as_str().unwrap().into(),
        cache_control,
    }
}

async fn issue_tokens(server: &TestServer, session: &str, name: &str) -> TokenBundle {
    let client = register(server, name, "https://client.example/cb").await;
    let code = authorization_code(server, session, &client).await;
    let response = exchange_code(
        server,
        &client.id,
        &code,
        VERIFIER,
        Some(&client.redirect_uri),
        false,
    )
    .await;
    token_bundle(response, &client.id).await
}

async fn refresh(
    server: &TestServer,
    client_id: &str,
    refresh_token: &str,
    resource: Option<&str>,
) -> Response {
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
    ];
    if let Some(resource) = resource {
        form.push(("resource", resource));
    }
    server
        .http
        .post(server.url("/token"))
        .form(&form)
        .send()
        .await
        .unwrap()
}

async fn assert_error(response: Response, status: StatusCode, error: &str) {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"], error);
}

fn tools_list() -> Value {
    json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
}

fn assert_no_store(response: &Response) {
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
}

async fn create_api_token(server: &TestServer, session: &str, name: &str) -> Value {
    let response = server
        .http
        .post(server.url("/api/tokens"))
        .header(header::COOKIE, session)
        .header(header::ORIGIN, &server.public_url)
        .json(&json!({"name": name}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_no_store(&response);
    response.json().await.unwrap()
}

async fn api_tokens(server: &TestServer, session: &str) -> Value {
    let response = server
        .http
        .get(server.url("/api/tokens"))
        .header(header::COOKIE, session)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_no_store(&response);
    response.json().await.unwrap()
}

#[test]
fn config_parsing_and_validation_follow_the_enabled_methods() {
    for (value, expected) in [
        ("OAuth", AuthMode::OAuth),
        ("both", AuthMode::Both),
        ("TOKEN", AuthMode::Token),
    ] {
        let config =
            Config::parse(&format!("[server]\nauth = \"{value}\""), Path::new("")).unwrap();
        assert_eq!(config.server.auth, expected);
    }
    assert!(
        Config::parse("[server]\nauth = \"oidc\"", Path::new("")).is_err(),
        "an unknown mode must not silently select a default"
    );

    let config = Config::parse(VALID_OAUTH, Path::new("")).unwrap();
    assert_eq!(config.oauth.public_url, PUBLIC_URL);
    assert_eq!(config.oauth.google_client_id, GOOGLE_CLIENT_ID);
    assert_eq!(config.oauth.google_client_secret, "google-secret");
    assert_eq!(config.oauth.allowed_emails, [EMAIL]);
    assert!(
        Config::parse("[oauth]\nunknown = true", Path::new("")).is_err(),
        "a misspelled OAuth setting must not be ignored"
    );

    for mode in ["token", "both"] {
        let config = Config::parse(
            &format!("[server]\nauth = \"{mode}\"\ntoken = \"short\"\n{VALID_OAUTH}"),
            Path::new(""),
        )
        .unwrap();
        assert!(config.validate().is_err(), "{mode} accepted a short token");
    }
    for mode in ["oauth", "both"] {
        let config = Config::parse(
            &format!(
                "[server]\nauth = \"{mode}\"\ntoken = \"{SERVER_TOKEN}\"\n[oauth]\npublic_url = \"{PUBLIC_URL}\""
            ),
            Path::new(""),
        )
        .unwrap();
        assert!(
            config.validate().is_err(),
            "{mode} accepted missing Google settings"
        );
        for public_url in [
            "http://example.com",
            "https://example.com/path",
            "https://example.com/?query=yes",
            "https://example.com/a/..",
        ] {
            let config = Config::parse(
                &format!(
                    "[server]\nauth = \"{mode}\"\ntoken = \"{SERVER_TOKEN}\"\n{}",
                    VALID_OAUTH.replace(PUBLIC_URL, public_url)
                ),
                Path::new(""),
            )
            .unwrap();
            assert!(
                config.validate().is_err(),
                "{mode} accepted public_url {public_url}"
            );
        }
    }
    for public_url in ["http://localhost", "http://127.0.0.1", "http://[::1]"] {
        let config = Config::parse(
            &format!(
                "[server]\nauth = \"oauth\"\n{}",
                VALID_OAUTH.replace(PUBLIC_URL, public_url)
            ),
            Path::new(""),
        )
        .unwrap();
        assert!(config.validate().is_ok(), "rejected {public_url}");
    }
    let token_only = Config::parse(
        &format!(
            "[server]\nauth = \"token\"\ntoken = \"{SERVER_TOKEN}\"\n[oauth]\npublic_url = \"not a URL\""
        ),
        Path::new(""),
    )
    .unwrap();
    assert!(token_only.validate().is_ok());
    let oauth_only = Config::parse(
        &format!("[server]\nauth = \"oauth\"\ntoken = \"short\"\n{VALID_OAUTH}"),
        Path::new(""),
    )
    .unwrap();
    assert!(oauth_only.validate().is_ok());
}

#[tokio::test]
async fn auth_modes_mount_only_their_routes_and_accept_only_their_credentials() {
    let token = TestServer::spawn(AuthMode::Token).await;
    let methods: Value = token
        .http
        .get(token.url("/api/auth"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(methods, json!({"methods": ["token"]}));
    for path in [
        "/.well-known/oauth-authorization-server",
        "/authorize",
        "/auth/login",
        "/api/grants",
    ] {
        let response = token.http.get(token.url(path)).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
    for path in ["/register", "/token"] {
        let response = token.http.post(token.url(path)).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
    assert_eq!(
        token.mcp(Some(SERVER_TOKEN), tools_list()).await.status(),
        StatusCode::OK
    );
    assert_eq!(
        token
            .http
            .get(token.url("/api/settings"))
            .bearer_auth(SERVER_TOKEN)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let oauth = TestServer::spawn(AuthMode::OAuth).await;
    let methods: Value = oauth
        .http
        .get(oauth.url("/api/auth"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(methods, json!({"methods": ["google"]}));
    assert_eq!(
        oauth.mcp(Some(SERVER_TOKEN), tools_list()).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        oauth
            .http
            .get(oauth.url("/api/settings"))
            .bearer_auth(SERVER_TOKEN)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        oauth
            .http
            .post(oauth.url("/api/login"))
            .json(&json!({"token": SERVER_TOKEN}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );

    let both = TestServer::spawn(AuthMode::Both).await;
    let methods: Value = both
        .http
        .get(both.url("/api/auth"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(methods, json!({"methods": ["google", "token"]}));
    assert_eq!(
        both.mcp(Some(SERVER_TOKEN), tools_list()).await.status(),
        StatusCode::OK
    );
    let session = google_sign_in(&both).await;
    let grant = issue_tokens(&both, &session, "Both modes").await;
    assert_eq!(
        both.mcp(Some(&grant.access_token), tools_list())
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        both.http
            .post(both.url("/api/login"))
            .json(&json!({"token": SERVER_TOKEN}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
}

#[tokio::test]
async fn metadata_uses_the_normalized_public_url() {
    for public_url in [PUBLIC_URL, "https://pensieve.test/"] {
        let server = TestServer::spawn_with(AuthMode::OAuth, public_url, vec![EMAIL.into()]).await;
        let resource = json!({
            "resource": format!("{PUBLIC_URL}/mcp"),
            "authorization_servers": [PUBLIC_URL],
            "scopes_supported": ["pensieve"],
            "bearer_methods_supported": ["header"],
            "resource_name": "Pensieve",
        });
        for path in [
            "/.well-known/oauth-protected-resource",
            "/.well-known/oauth-protected-resource/mcp",
        ] {
            let body: Value = server
                .http
                .get(server.url(path))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(body, resource, "{path}");
        }
        let body: Value = server
            .http
            .get(server.url("/.well-known/oauth-authorization-server"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            body,
            json!({
                "issuer": PUBLIC_URL,
                "authorization_endpoint": format!("{PUBLIC_URL}/authorize"),
                "token_endpoint": format!("{PUBLIC_URL}/token"),
                "registration_endpoint": format!("{PUBLIC_URL}/register"),
                "response_types_supported": ["code"],
                "grant_types_supported": ["authorization_code", "refresh_token"],
                "code_challenge_methods_supported": ["S256"],
                "token_endpoint_auth_methods_supported": ["none"],
                "scopes_supported": ["pensieve"],
                "authorization_response_iss_parameter_supported": true,
            })
        );
    }
}

#[tokio::test]
async fn registration_rejects_unsafe_redirects_and_oversized_metadata() {
    let server = TestServer::spawn(AuthMode::OAuth).await;
    let response = server
        .http
        .post(server.url("/register"))
        .json(&json!({
            "client_name": "  Test app  ",
            "redirect_uris": ["https://client.example/cb"],
            "token_endpoint_auth_method": "client_secret_basic",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let body: Value = response.json().await.unwrap();
    assert!(body["client_id"].as_str().is_some_and(|id| !id.is_empty()));
    assert!(body["client_id_issued_at"].is_number());
    assert_eq!(body["client_name"], "Test app");
    assert_eq!(body["redirect_uris"], json!(["https://client.example/cb"]));
    assert_eq!(
        body["grant_types"],
        json!(["authorization_code", "refresh_token"])
    );
    assert_eq!(body["response_types"], json!(["code"]));
    assert_eq!(body["token_endpoint_auth_method"], "none");

    for redirect_uri in [
        "http://example.com/cb",
        "myapp://cb",
        "javascript:alert(1)",
        "https://u:p@host/cb",
        "https://client.example/cb#fragment",
    ] {
        let response = server
            .http
            .post(server.url("/register"))
            .json(&json!({"redirect_uris": [redirect_uri]}))
            .send()
            .await
            .unwrap();
        assert_error(response, StatusCode::BAD_REQUEST, "invalid_redirect_uri").await;
    }
    let response = server
        .http
        .post(server.url("/register"))
        .json(&json!({"client_name": "Missing redirects"}))
        .send()
        .await
        .unwrap();
    assert_error(response, StatusCode::BAD_REQUEST, "invalid_client_metadata").await;
    let response = server
        .http
        .post(server.url("/register"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(" ".repeat(16 * 1024 + 1))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn google_callback_validates_state_nonce_identity_and_allowlist() {
    let server = TestServer::spawn(AuthMode::OAuth).await;

    let start = start_google(&server, Some("/authorize?client_id=test")).await;
    server.mock.prepare(&server, &start, EMAIL);
    let response = google_callback(&server, &start, &start.state, Some("google-code")).await;
    assert_eq!(response.status(), StatusCode::FOUND);
    assert_eq!(location(&response), "/authorize?client_id=test");
    let attributes = set_cookie(&response, "pensieve_session").to_ascii_lowercase();
    assert!(attributes.contains("httponly"));
    assert!(attributes.contains("samesite=lax"));
    assert!(!attributes.contains("domain="));

    for next in ["https://evil.example", "//evil.example", "/settings"] {
        let start = start_google(&server, Some(next)).await;
        server.mock.prepare(&server, &start, EMAIL);
        let response = google_callback(&server, &start, &start.state, Some("google-code")).await;
        assert_eq!(response.status(), StatusCode::FOUND);
        assert_eq!(location(&response), "/", "unsafe next {next}");
    }

    let start = start_google(&server, None).await;
    server.mock.prepare(&server, &start, EMAIL);
    let response = google_callback(&server, &start, "wrong-state", Some("google-code")).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let start = start_google(&server, None).await;
    server.mock.prepare(&server, &start, EMAIL);
    let calls = server.mock.calls();
    let response = google_callback(&server, &start, &start.state, None).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        server.mock.calls(),
        calls,
        "Google was called without a code"
    );

    let start = start_google(&server, None).await;
    server.mock.prepare(&server, &start, EMAIL);
    server.mock.claims.lock().unwrap()["nonce"] = json!("wrong-nonce");
    let response = google_callback(&server, &start, &start.state, Some("google-code")).await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);

    let start = start_google(&server, None).await;
    server.mock.prepare(&server, &start, EMAIL);
    server
        .mock
        .claims
        .lock()
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("sub");
    let response = google_callback(&server, &start, &start.state, Some("google-code")).await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);

    let start = start_google(&server, None).await;
    server.mock.prepare(&server, &start, EMAIL);
    server.mock.claims.lock().unwrap()["email_verified"] = json!(false);
    let response = google_callback(&server, &start, &start.state, Some("google-code")).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let start = start_google(&server, None).await;
    server.mock.prepare(&server, &start, "stranger@example.com");
    let response = google_callback(&server, &start, &start.state, Some("google-code")).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let start = start_google(&server, None).await;
    server.mock.prepare(&server, &start, "UsEr@ExAmPlE.CoM");
    let response = google_callback(&server, &start, &start.state, Some("google-code")).await;
    assert_eq!(response.status(), StatusCode::FOUND);
    assert!(set_cookie(&response, "pensieve_session").starts_with("pensieve_session="));
}

#[tokio::test]
async fn google_sessions_are_read_only_single_and_time_limited() {
    let server = TestServer::spawn(AuthMode::OAuth).await;
    let session = google_sign_in(&server).await;
    assert_eq!(
        server
            .http
            .get(server.url("/api/settings"))
            .header(header::COOKIE, &session)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        server
            .http
            .put(server.url("/api/pages/X"))
            .header(header::COOKIE, &session)
            .json(&json!({"content": "must not be written"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        server
            .http
            .post(server.url("/mcp"))
            .header(header::COOKIE, &session)
            .json(&tools_list())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        server
            .http
            .get(server.url("/api/settings"))
            .header(header::COOKIE, format!("{session}; {session}"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    server.advance(30 * 24 * 60 * 60);
    assert_eq!(
        server
            .http
            .get(server.url("/api/settings"))
            .header(header::COOKIE, session)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn authorize_validates_the_client_redirect_pkce_resource_and_session() {
    let server = TestServer::spawn(AuthMode::OAuth).await;
    let session = google_sign_in(&server).await;
    let client = register(&server, "Client", "https://client.example/cb").await;
    let resource = format!("{PUBLIC_URL}/mcp");

    let unknown = RegisteredClient {
        id: "unknown-client".into(),
        name: client.name.clone(),
        redirect_uri: client.redirect_uri.clone(),
    };
    let response = server
        .http
        .get(authorize_url(
            &server,
            &unknown,
            &unknown.redirect_uri,
            "state",
            true,
            &resource,
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(!response.headers().contains_key(header::LOCATION));

    let response = server
        .http
        .get(authorize_url(
            &server,
            &client,
            "https://client.example/other",
            "state",
            true,
            &resource,
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(!response.headers().contains_key(header::LOCATION));

    let loopback = register(&server, "Loopback", "http://127.0.0.1:1234/callback").await;
    let response = server
        .http
        .get(authorize_url(
            &server,
            &loopback,
            "http://127.0.0.1:5678/callback",
            "state",
            true,
            &resource,
        ))
        .header(header::COOKIE, &session)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = server
        .http
        .get(authorize_url(
            &server,
            &loopback,
            "http://127.0.0.1:5678/other",
            "state",
            true,
            &resource,
        ))
        .header(header::COOKIE, &session)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    for redirect_uri in [
        "http://user@127.0.0.1:5678/callback",
        "http://127.0.0.1:5678/callback#fragment",
    ] {
        let response = server
            .http
            .get(authorize_url(
                &server,
                &loopback,
                redirect_uri,
                "state",
                true,
                &resource,
            ))
            .header(header::COOKIE, &session)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(!response.headers().contains_key(header::LOCATION));
    }

    let response = server
        .http
        .get(authorize_url(
            &server,
            &client,
            &client.redirect_uri,
            "original-state",
            false,
            &resource,
        ))
        .header(header::COOKIE, &session)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FOUND);
    let parameters = query_parameters(&redirect_url(&response));
    assert_eq!(parameters["error"], "invalid_request");
    assert_eq!(parameters["state"], "original-state");
    assert_eq!(parameters["iss"], PUBLIC_URL);

    // A 44-character challenge can't be a SHA-256 digest, so no verifier could ever redeem its code.
    let mut url = authorize_url(
        &server,
        &client,
        &client.redirect_uri,
        "state",
        false,
        &resource,
    );
    url.query_pairs_mut()
        .append_pair("code_challenge", &format!("{}A", challenge(VERIFIER)))
        .append_pair("code_challenge_method", "S256");
    let response = server
        .http
        .get(url)
        .header(header::COOKIE, &session)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FOUND);
    assert_eq!(
        query_parameters(&redirect_url(&response))["error"],
        "invalid_request"
    );

    let response = server
        .http
        .get(authorize_url(
            &server,
            &client,
            &client.redirect_uri,
            "state",
            true,
            "https://wrong.example/mcp",
        ))
        .header(header::COOKIE, &session)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FOUND);
    assert_eq!(
        query_parameters(&redirect_url(&response))["error"],
        "invalid_target"
    );

    let url = authorize_url(
        &server,
        &client,
        &client.redirect_uri,
        "state with spaces",
        true,
        &resource,
    );
    let original = format!("/authorize?{}", url.query().unwrap());
    let response = server.http.get(url).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::FOUND);
    let login = Url::parse(&server.root)
        .unwrap()
        .join(&location(&response))
        .unwrap();
    assert_eq!(login.path(), "/auth/login");
    assert_eq!(query_parameters(&login)["next"], original);
}

#[tokio::test]
async fn consent_html_escapes_client_data_and_restricts_form_redirects() {
    let server = TestServer::spawn(AuthMode::OAuth).await;
    let session = google_sign_in(&server).await;
    let client = register(
        &server,
        "<script>alert(1)</script>",
        "https://client.example/cb",
    )
    .await;
    let url = authorize_url(
        &server,
        &client,
        &client.redirect_uri,
        "state",
        true,
        &format!("{PUBLIC_URL}/mcp"),
    );
    let response = server
        .http
        .get(url)
        .header(header::COOKIE, session)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let csp = response.headers()[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .unwrap();
    assert!(csp.contains("form-action 'self' https://client.example"));
    assert!(csp.contains("frame-ancestors 'none'"));
    // Under `no-referrer` browsers post the consent form with `Origin: null`, which the POST rejects.
    assert_eq!(response.headers()[header::REFERRER_POLICY], "same-origin");
    let html = response.text().await.unwrap();
    assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert!(!html.contains("<script>alert(1)</script>"));
}

#[tokio::test]
async fn consent_posts_check_origin_identity_decision_single_use_and_expiry() {
    let server = TestServer::spawn(AuthMode::OAuth).await;
    let session = google_sign_in(&server).await;
    let other_session = {
        let start = start_google(&server, None).await;
        server.mock.prepare(&server, &start, OTHER_EMAIL);
        let response = google_callback(&server, &start, &start.state, Some("google-code")).await;
        assert_eq!(response.status(), StatusCode::FOUND);
        cookie(&response, "pensieve_session")
    };
    let client = register(&server, "Client", "https://client.example/cb").await;

    let (deny, _) = consent(
        &server,
        &session,
        &client,
        &client.redirect_uri,
        "deny-state",
    )
    .await;
    assert_eq!(
        post_consent(&server, &session, &deny, "deny", None)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        post_consent(
            &server,
            &session,
            &deny,
            "deny",
            Some("https://evil.example"),
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    let response = post_consent(&server, &session, &deny, "deny", Some(&server.public_url)).await;
    assert_eq!(response.status(), StatusCode::FOUND);
    let parameters = query_parameters(&redirect_url(&response));
    assert_eq!(parameters["error"], "access_denied");
    assert_eq!(parameters["state"], "deny-state");

    let (approve, _) = consent(
        &server,
        &session,
        &client,
        &client.redirect_uri,
        "approve-state",
    )
    .await;
    let response = post_consent(
        &server,
        &session,
        &approve,
        "approve",
        Some(&server.public_url),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FOUND);
    let parameters = query_parameters(&redirect_url(&response));
    assert!(!parameters["code"].is_empty());
    assert_eq!(parameters["state"], "approve-state");
    assert_eq!(parameters["iss"], PUBLIC_URL);
    assert_eq!(
        post_consent(
            &server,
            &session,
            &approve,
            "approve",
            Some(&server.public_url),
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );

    let (other, _) = consent(&server, &session, &client, &client.redirect_uri, "state").await;
    assert_eq!(
        post_consent(
            &server,
            &other_session,
            &other,
            "approve",
            Some(&server.public_url),
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );

    let (expired, _) = consent(&server, &session, &client, &client.redirect_uri, "state").await;
    server.advance(600);
    assert_eq!(
        post_consent(
            &server,
            &session,
            &expired,
            "approve",
            Some(&server.public_url),
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn authorization_codes_are_pkce_bound_single_use_and_time_limited() {
    let server = TestServer::spawn(AuthMode::OAuth).await;
    let session = google_sign_in(&server).await;
    let grant = issue_tokens(&server, &session, "Happy path").await;
    assert_eq!(grant.cache_control, "no-store");
    assert!(!grant.access_token.is_empty() && !grant.refresh_token.is_empty());

    let client = register(&server, "Code binding", "https://client.example/cb").await;
    let other = register(&server, "Other client", "https://other.example/cb").await;

    let code = authorization_code(&server, &session, &client).await;
    assert_error(
        exchange_code(
            &server,
            &client.id,
            &code,
            WRONG_VERIFIER,
            Some(&client.redirect_uri),
            false,
        )
        .await,
        StatusCode::BAD_REQUEST,
        "invalid_grant",
    )
    .await;
    assert_error(
        exchange_code(
            &server,
            &client.id,
            &code,
            VERIFIER,
            Some(&client.redirect_uri),
            false,
        )
        .await,
        StatusCode::BAD_REQUEST,
        "invalid_grant",
    )
    .await;

    let code = authorization_code(&server, &session, &client).await;
    assert_error(
        exchange_code(
            &server,
            &other.id,
            &code,
            VERIFIER,
            Some(&client.redirect_uri),
            false,
        )
        .await,
        StatusCode::BAD_REQUEST,
        "invalid_grant",
    )
    .await;

    let code = authorization_code(&server, &session, &client).await;
    assert_error(
        exchange_code(
            &server,
            &client.id,
            &code,
            VERIFIER,
            Some("https://client.example/other"),
            false,
        )
        .await,
        StatusCode::BAD_REQUEST,
        "invalid_grant",
    )
    .await;

    let code = authorization_code(&server, &session, &client).await;
    let response = exchange_code(&server, &client.id, &code, VERIFIER, None, false).await;
    token_bundle(response, &client.id).await;
    assert_error(
        exchange_code(&server, &client.id, &code, VERIFIER, None, false).await,
        StatusCode::BAD_REQUEST,
        "invalid_grant",
    )
    .await;

    let code = authorization_code(&server, &session, &client).await;
    server.advance(600);
    assert_error(
        exchange_code(
            &server,
            &client.id,
            &code,
            VERIFIER,
            Some(&client.redirect_uri),
            false,
        )
        .await,
        StatusCode::BAD_REQUEST,
        "invalid_grant",
    )
    .await;
}

#[tokio::test]
async fn token_requests_validate_client_authentication_and_form_encoding() {
    let server = TestServer::spawn(AuthMode::OAuth).await;
    assert_error(
        server
            .http
            .post(server.url("/token"))
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", "unknown"),
                ("client_id", "unknown-client"),
            ])
            .send()
            .await
            .unwrap(),
        StatusCode::UNAUTHORIZED,
        "invalid_client",
    )
    .await;
    let response = server
        .http
        .post(server.url("/token"))
        .basic_auth("unknown-client", Option::<&str>::None)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", "unknown"),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.headers()[header::WWW_AUTHENTICATE],
        "Basic realm=\"pensieve\""
    );
    assert_error(response, StatusCode::UNAUTHORIZED, "invalid_client").await;

    let response = server
        .http
        .post(server.url("/token"))
        .basic_auth("basic-client", Option::<&str>::None)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", "token"),
            ("client_id", "form-client"),
        ])
        .send()
        .await
        .unwrap();
    assert_error(response, StatusCode::BAD_REQUEST, "invalid_request").await;
    let response = server
        .http
        .post(server.url("/token"))
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body("grant_type=refresh_token&grant_type=refresh_token&refresh_token=token&client_id=client")
        .send()
        .await
        .unwrap();
    assert_error(response, StatusCode::BAD_REQUEST, "invalid_request").await;
    assert_error(
        server
            .http
            .post(server.url("/token"))
            .form(&[("refresh_token", "token"), ("client_id", "client")])
            .send()
            .await
            .unwrap(),
        StatusCode::BAD_REQUEST,
        "invalid_request",
    )
    .await;
    assert_error(
        server
            .http
            .post(server.url("/token"))
            .form(&[
                ("grant_type", "client_credentials"),
                ("client_id", "client"),
            ])
            .send()
            .await
            .unwrap(),
        StatusCode::BAD_REQUEST,
        "unsupported_grant_type",
    )
    .await;

    let session = google_sign_in(&server).await;
    let client = register(&server, "Basic client", "https://client.example/cb").await;
    let code = authorization_code(&server, &session, &client).await;
    let response = exchange_code(
        &server,
        &client.id,
        &code,
        VERIFIER,
        Some(&client.redirect_uri),
        true,
    )
    .await;
    token_bundle(response, &client.id).await;
}

#[tokio::test]
async fn access_tokens_write_only_through_mcp_and_expire() {
    let server = TestServer::spawn(AuthMode::OAuth).await;
    let session = google_sign_in(&server).await;
    let grant = issue_tokens(&server, &session, "MCP client").await;
    assert_eq!(
        server
            .mcp(Some(&grant.access_token), tools_list())
            .await
            .status(),
        StatusCode::OK
    );
    let write = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {
            "name": "write",
            "arguments": {
                "title": "OAuthWrite",
                "content": "OAuth access token wrote this page.",
                "summary": "Test OAuth write access"
            }
        }
    });
    let response = server.mcp(Some(&grant.access_token), write).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["result"]["isError"], false, "{body}");
    let read = json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {"name": "read", "arguments": {"title": "OAuthWrite"}}
    });
    let body: Value = server
        .mcp(Some(&grant.access_token), read)
        .await
        .json()
        .await
        .unwrap();
    assert!(
        body["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("OAuth access token wrote this page."),
        "{body}"
    );
    assert_eq!(
        server
            .http
            .put(server.url("/api/pages/X"))
            .bearer_auth(&grant.access_token)
            .json(&json!({"content": "must not be written"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );

    let response = server.mcp(Some("unknown-token"), tools_list()).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response.headers()[header::WWW_AUTHENTICATE],
        "Bearer error=\"invalid_token\", resource_metadata=\"https://pensieve.test/.well-known/oauth-protected-resource/mcp\""
    );
    let response = server.mcp(None, tools_list()).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response.headers()[header::WWW_AUTHENTICATE],
        "Bearer resource_metadata=\"https://pensieve.test/.well-known/oauth-protected-resource/mcp\""
    );

    server.advance(3600);
    assert_eq!(
        server
            .mcp(Some(&grant.access_token), tools_list())
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn refresh_rotation_issues_working_tokens_and_replay_revokes_the_grant() {
    let server = TestServer::spawn(AuthMode::OAuth).await;
    let session = google_sign_in(&server).await;
    let first = issue_tokens(&server, &session, "Refresh client").await;
    let second = token_bundle(
        refresh(&server, &first.client_id, &first.refresh_token, None).await,
        &first.client_id,
    )
    .await;
    assert_ne!(first.refresh_token, second.refresh_token);
    assert_eq!(
        server
            .mcp(Some(&first.access_token), tools_list())
            .await
            .status(),
        StatusCode::OK,
        "rotation must not expire earlier access tokens"
    );
    assert_eq!(
        server
            .mcp(Some(&second.access_token), tools_list())
            .await
            .status(),
        StatusCode::OK
    );
    let third = token_bundle(
        refresh(&server, &second.client_id, &second.refresh_token, None).await,
        &second.client_id,
    )
    .await;

    assert_error(
        refresh(&server, &first.client_id, &first.refresh_token, None).await,
        StatusCode::BAD_REQUEST,
        "invalid_grant",
    )
    .await;
    assert_error(
        refresh(&server, &third.client_id, &third.refresh_token, None).await,
        StatusCode::BAD_REQUEST,
        "invalid_grant",
    )
    .await;
    for access_token in [first.access_token, second.access_token, third.access_token] {
        assert_eq!(
            server.mcp(Some(&access_token), tools_list()).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn concurrent_refresh_replay_revokes_all_issued_tokens() {
    let server = TestServer::spawn(AuthMode::OAuth).await;
    let session = google_sign_in(&server).await;
    let first = issue_tokens(&server, &session, "Concurrent refresh client").await;

    let (left, right) = tokio::join!(
        refresh(&server, &first.client_id, &first.refresh_token, None),
        refresh(&server, &first.client_id, &first.refresh_token, None),
    );
    let mut rejected = false;
    let mut issued = Vec::new();
    for response in [left, right] {
        if response.status() == StatusCode::OK {
            issued.push(token_bundle(response, &first.client_id).await);
        } else {
            assert_error(response, StatusCode::BAD_REQUEST, "invalid_grant").await;
            rejected = true;
        }
    }
    assert!(rejected, "neither concurrent refresh was rejected");

    let mut access_tokens = vec![first.access_token];
    for grant in issued {
        assert_error(
            refresh(&server, &grant.client_id, &grant.refresh_token, None).await,
            StatusCode::BAD_REQUEST,
            "invalid_grant",
        )
        .await;
        access_tokens.push(grant.access_token);
    }
    for access_token in access_tokens {
        assert_eq!(
            server.mcp(Some(&access_token), tools_list()).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn refresh_checks_client_resource_allowlist_and_current_public_url() {
    let server = TestServer::spawn(AuthMode::OAuth).await;
    let session = google_sign_in(&server).await;
    let first = issue_tokens(&server, &session, "First client").await;
    let other = issue_tokens(&server, &session, "Other client").await;
    assert_error(
        refresh(&server, &other.client_id, &first.refresh_token, None).await,
        StatusCode::BAD_REQUEST,
        "invalid_grant",
    )
    .await;
    assert_eq!(
        server
            .mcp(Some(&first.access_token), tools_list())
            .await
            .status(),
        StatusCode::OK,
        "another client's failed refresh revoked the grant"
    );
    assert_error(
        refresh(
            &server,
            &first.client_id,
            &first.refresh_token,
            Some("https://wrong.example/mcp"),
        )
        .await,
        StatusCode::BAD_REQUEST,
        "invalid_target",
    )
    .await;
    token_bundle(
        refresh(&server, &first.client_id, &first.refresh_token, None).await,
        &first.client_id,
    )
    .await;

    let removed = TestServer::spawn(AuthMode::OAuth).await;
    let removed_session = google_sign_in(&removed).await;
    let removed_grant = issue_tokens(&removed, &removed_session, "Removed email").await;
    let restarted = removed.restart(PUBLIC_URL, vec![OTHER_EMAIL.into()]).await;
    assert_error(
        refresh(
            &restarted,
            &removed_grant.client_id,
            &removed_grant.refresh_token,
            None,
        )
        .await,
        StatusCode::BAD_REQUEST,
        "invalid_grant",
    )
    .await;
    assert_eq!(
        restarted
            .mcp(Some(&removed_grant.access_token), tools_list())
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );

    let original = TestServer::spawn(AuthMode::OAuth).await;
    let original_session = google_sign_in(&original).await;
    let original_grant = issue_tokens(&original, &original_session, "Original URL").await;
    let moved = original
        .restart("https://moved.example", vec![EMAIL.into()])
        .await;
    assert_error(
        refresh(
            &moved,
            &original_grant.client_id,
            &original_grant.refresh_token,
            None,
        )
        .await,
        StatusCode::BAD_REQUEST,
        "invalid_grant",
    )
    .await;
    assert_eq!(
        moved
            .mcp(Some(&original_grant.access_token), tools_list())
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn connected_apps_list_and_revoke_grants() {
    let server = TestServer::spawn(AuthMode::OAuth).await;
    let session = google_sign_in(&server).await;
    let grant = issue_tokens(&server, &session, "Connected client").await;
    let response = server
        .http
        .get(server.url("/api/grants"))
        .header(header::COOKIE, &session)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let grants: Value = response.json().await.unwrap();
    let listed = grants
        .as_array()
        .unwrap()
        .iter()
        .find(|grant| grant["client_name"] == "Connected client")
        .unwrap();
    assert_eq!(listed["email"], EMAIL);
    let id = listed["id"].as_str().unwrap();

    let response = server
        .http
        .delete(server.url(&format!("/api/grants/{id}")))
        .header(header::COOKIE, &session)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(response.text().await.unwrap().is_empty());
    assert_eq!(
        server
            .mcp(Some(&grant.access_token), tools_list())
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_error(
        refresh(&server, &grant.client_id, &grant.refresh_token, None).await,
        StatusCode::BAD_REQUEST,
        "invalid_grant",
    )
    .await;
    assert_eq!(
        server
            .http
            .delete(server.url("/api/grants/unknown"))
            .header(header::COOKIE, session)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn api_tokens_create_authenticate_list_and_revoke() {
    let server = TestServer::spawn(AuthMode::OAuth).await;
    let session = google_sign_in(&server).await;
    let created = create_api_token(&server, &session, "Writer").await;
    let fields = created.as_object().unwrap();
    assert_eq!(fields.len(), 5);
    for field in ["id", "name", "email", "created_at", "token"] {
        assert!(fields[field].is_string(), "missing string field {field}");
    }
    assert_eq!(created["name"], "Writer");
    assert_eq!(created["email"], EMAIL);
    let id = created["id"].as_str().unwrap();
    let token = created["token"].as_str().unwrap();
    assert!(token.starts_with("pensieve_pat_"));

    let response = server
        .http
        .put(server.url("/api/pages/X"))
        .bearer_auth(token)
        .json(&json!({"content": "Written by an API token."}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = server
        .http
        .get(server.url("/api/pages/X?visit=false"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let page: Value = response.json().await.unwrap();
    assert_eq!(page["content"], "Written by an API token.");
    assert_eq!(
        server.mcp(Some(token), tools_list()).await.status(),
        StatusCode::OK
    );

    let tokens = api_tokens(&server, &session).await;
    let listed = &tokens.as_array().unwrap()[0];
    assert_eq!(tokens.as_array().unwrap().len(), 1);
    assert_eq!(listed["id"], created["id"]);
    assert_eq!(listed["name"], created["name"]);
    assert_eq!(listed["email"], created["email"]);
    assert_eq!(listed["created_at"], created["created_at"]);
    assert!(listed.get("token").is_none());
    assert!(listed.get("hash").is_none());

    let response = server
        .http
        .delete(server.url(&format!("/api/tokens/{id}")))
        .header(header::COOKIE, &session)
        .header(header::ORIGIN, &server.public_url)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_no_store(&response);
    assert!(response.text().await.unwrap().is_empty());
    assert_eq!(
        server
            .http
            .get(server.url("/api/pages/X?visit=false"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let response = server.mcp(Some(token), tools_list()).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response.headers()[header::WWW_AUTHENTICATE],
        format!(
            "Bearer error=\"invalid_token\", resource_metadata=\"{}/.well-known/oauth-protected-resource/mcp\"",
            server.public_url
        )
    );
    let response = server
        .http
        .delete(server.url(&format!("/api/tokens/{id}")))
        .header(header::COOKIE, &session)
        .header(header::ORIGIN, &server.public_url)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_no_store(&response);
    assert_eq!(api_tokens(&server, &session).await, json!([]));
}

#[tokio::test]
async fn bearers_cannot_manage_api_tokens() {
    let server = TestServer::spawn(AuthMode::OAuth).await;
    let session = google_sign_in(&server).await;
    let api_token = create_api_token(&server, &session, "API bearer").await;
    let oauth = issue_tokens(&server, &session, "OAuth bearer").await;
    for bearer in [
        api_token["token"].as_str().unwrap(),
        oauth.access_token.as_str(),
    ] {
        let response = server
            .http
            .get(server.url("/api/tokens"))
            .bearer_auth(bearer)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_no_store(&response);
        let response = server
            .http
            .post(server.url("/api/tokens"))
            .bearer_auth(bearer)
            .header(header::ORIGIN, &server.public_url)
            .json(&json!({"name": "Must not be created"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_no_store(&response);
    }
    assert_eq!(
        api_tokens(&server, &session)
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let both = TestServer::spawn(AuthMode::Both).await;
    let both_session = google_sign_in(&both).await;
    let response = both
        .http
        .get(both.url("/api/tokens"))
        .bearer_auth(SERVER_TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_no_store(&response);
    let response = both
        .http
        .post(both.url("/api/tokens"))
        .bearer_auth(SERVER_TOKEN)
        .header(header::ORIGIN, &both.public_url)
        .json(&json!({"name": "Must not be created"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_no_store(&response);
    assert_eq!(api_tokens(&both, &both_session).await, json!([]));
}

#[tokio::test]
async fn token_sessions_can_list_but_not_manage_api_tokens() {
    let server = TestServer::spawn(AuthMode::Both).await;
    let google_session = google_sign_in(&server).await;
    let created = create_api_token(&server, &google_session, "Protected").await;
    let id = created["id"].as_str().unwrap();
    let response = server
        .http
        .post(server.url("/api/login"))
        .json(&json!({"token": SERVER_TOKEN}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let token_session = cookie(&response, "pensieve_session");
    assert_eq!(
        api_tokens(&server, &token_session)
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let response = server
        .http
        .post(server.url("/api/tokens"))
        .header(header::COOKIE, &token_session)
        .header(header::ORIGIN, &server.public_url)
        .header(header::CONTENT_TYPE, "text/plain")
        .body("not JSON")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_no_store(&response);
    let response = server
        .http
        .delete(server.url(&format!("/api/tokens/{id}")))
        .header(header::COOKIE, &token_session)
        .header(header::ORIGIN, &server.public_url)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_no_store(&response);

    let response = server
        .http
        .get(server.url("/api/tokens"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_no_store(&response);
    let response = server
        .http
        .post(server.url("/api/tokens"))
        .header(header::ORIGIN, &server.public_url)
        .header(header::CONTENT_TYPE, "text/plain")
        .body("not JSON")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_no_store(&response);
    let response = server
        .http
        .delete(server.url(&format!("/api/tokens/{id}")))
        .header(header::ORIGIN, &server.public_url)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_no_store(&response);
    assert_eq!(
        api_tokens(&server, &google_session)
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn api_token_mutations_require_the_public_origin() {
    let server = TestServer::spawn(AuthMode::OAuth).await;
    let session = google_sign_in(&server).await;
    let created = create_api_token(&server, &session, "Origin protected").await;
    let id = created["id"].as_str().unwrap();
    let token = created["token"].as_str().unwrap();

    for origin in [None, Some("null"), Some("https://evil.example")] {
        let request = server
            .http
            .post(server.url("/api/tokens"))
            .header(header::COOKIE, &session)
            .header(header::CONTENT_TYPE, "text/plain")
            .body(r#"{"name":"Must not be created"}"#);
        let request = match origin {
            Some(origin) => request.header(header::ORIGIN, origin),
            None => request,
        };
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_no_store(&response);

        let request = server
            .http
            .delete(server.url(&format!("/api/tokens/{id}")))
            .header(header::COOKIE, &session);
        let request = match origin {
            Some(origin) => request.header(header::ORIGIN, origin),
            None => request,
        };
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_no_store(&response);
    }
    assert_eq!(
        api_tokens(&server, &session)
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        server.mcp(Some(token), tools_list()).await.status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn api_token_creation_validates_body_and_name() {
    let server = TestServer::spawn(AuthMode::OAuth).await;
    let session = google_sign_in(&server).await;

    let response = server
        .http
        .post(server.url("/api/tokens"))
        .header(header::ORIGIN, &server.public_url)
        .header(header::CONTENT_TYPE, "text/plain")
        .body("not JSON")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_no_store(&response);
    let response = server
        .http
        .post(server.url("/api/tokens"))
        .header(header::COOKIE, &session)
        .header(header::ORIGIN, &server.public_url)
        .header(header::CONTENT_TYPE, "text/plain")
        .body(r#"{"name":"Wrong content type"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_no_store(&response);

    let oversized = format!(r#"{{"name":"{}"}}"#, "x".repeat(16_384));
    let response = server
        .http
        .post(server.url("/api/tokens"))
        .header(header::COOKIE, &session)
        .header(header::ORIGIN, &server.public_url)
        .header(header::CONTENT_TYPE, "application/json")
        .body(oversized)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_no_store(&response);
    let response = server
        .http
        .post(server.url("/api/tokens"))
        .header(header::COOKIE, &session)
        .header(header::ORIGIN, &server.public_url)
        .header(header::CONTENT_TYPE, "application/json")
        .body("{")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_no_store(&response);

    for body in [
        json!([]),
        json!("name"),
        json!({}),
        json!({"name": 1}),
        json!({"name": true}),
    ] {
        let response = server
            .http
            .post(server.url("/api/tokens"))
            .header(header::COOKIE, &session)
            .header(header::ORIGIN, &server.public_url)
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "{body}"
        );
        assert_no_store(&response);
    }
    let too_long = "é".repeat(101);
    for name in ["", " \t\n", too_long.as_str()] {
        let response = server
            .http
            .post(server.url("/api/tokens"))
            .header(header::COOKIE, &session)
            .header(header::ORIGIN, &server.public_url)
            .json(&json!({"name": name}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_no_store(&response);
    }

    let hundred = "é".repeat(100);
    let created = create_api_token(&server, &session, &hundred).await;
    assert_eq!(created["name"], json!(hundred));
    let created = create_api_token(&server, &session, " \t Script token \n").await;
    assert_eq!(created["name"], "Script token");
    let first = create_api_token(&server, &session, "Duplicate").await;
    let second = create_api_token(&server, &session, "Duplicate").await;
    assert_ne!(first["id"], second["id"]);

    let response = server
        .http
        .post(server.url("/api/tokens"))
        .header(header::COOKIE, &session)
        .header(header::ORIGIN, &server.public_url)
        .json(&json!({"name": "Unknown fields", "extra": true}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_no_store(&response);
    assert_eq!(
        api_tokens(&server, &session)
            .await
            .as_array()
            .unwrap()
            .len(),
        5
    );
}

#[tokio::test]
async fn api_tokens_follow_owner_allowlist() {
    let server = TestServer::spawn(AuthMode::OAuth).await;
    let session = google_sign_in(&server).await;
    let created = create_api_token(&server, &session, "Allowlisted").await;
    let token = created["token"].as_str().unwrap();
    assert_eq!(
        server
            .http
            .get(server.url("/api/settings"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let removed = server.restart(PUBLIC_URL, vec![OTHER_EMAIL.into()]).await;
    assert_eq!(
        removed
            .http
            .get(removed.url("/api/settings"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let response = removed.mcp(Some(token), tools_list()).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response.headers()[header::WWW_AUTHENTICATE],
        format!(
            "Bearer error=\"invalid_token\", resource_metadata=\"{}/.well-known/oauth-protected-resource/mcp\"",
            removed.public_url
        )
    );

    let restored = removed.restart(PUBLIC_URL, vec![EMAIL.into()]).await;
    assert_eq!(
        restored
            .http
            .get(restored.url("/api/settings"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        restored.mcp(Some(token), tools_list()).await.status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn api_tokens_are_unavailable_without_oauth() {
    let server = TestServer::spawn(AuthMode::Token).await;
    let response = server
        .http
        .get(server.url("/api/tokens"))
        .bearer_auth(SERVER_TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let response = server
        .http
        .post(server.url("/api/tokens"))
        .bearer_auth(SERVER_TOKEN)
        .header(header::ORIGIN, &server.public_url)
        .json(&json!({"name": "Not mounted"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let response = server
        .http
        .delete(server.url("/api/tokens/unknown"))
        .bearer_auth(SERVER_TOKEN)
        .header(header::ORIGIN, &server.public_url)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        server
            .http
            .get(server.url("/api/settings"))
            .bearer_auth("pensieve_pat_not_valid_in_token_mode")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        server
            .mcp(Some("pensieve_pat_not_valid_in_token_mode"), tools_list())
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn api_token_routes_ignore_authorization() {
    let server = TestServer::spawn(AuthMode::OAuth).await;
    let session = google_sign_in(&server).await;
    let bootstrap = create_api_token(&server, &session, "Bootstrap").await;
    let valid = bootstrap["token"].as_str().unwrap();

    for (index, bearer) in [None, Some(valid), Some("invalid-bearer")]
        .into_iter()
        .enumerate()
    {
        let request = server
            .http
            .get(server.url("/api/tokens"))
            .header(header::COOKIE, &session);
        let request = match bearer {
            Some(bearer) => request.bearer_auth(bearer),
            None => request,
        };
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_no_store(&response);

        let request = server
            .http
            .post(server.url("/api/tokens"))
            .header(header::COOKIE, &session)
            .header(header::ORIGIN, &server.public_url)
            .json(&json!({"name": format!("Cookie creation {index}")}));
        let request = match bearer {
            Some(bearer) => request.bearer_auth(bearer),
            None => request,
        };
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_no_store(&response);
    }
    assert_eq!(
        api_tokens(&server, &session)
            .await
            .as_array()
            .unwrap()
            .len(),
        4
    );
}

#[tokio::test]
async fn api_tokens_are_sorted_by_creation_then_id() {
    let server = TestServer::spawn(AuthMode::OAuth).await;
    let session = google_sign_in(&server).await;
    let older = create_api_token(&server, &session, "Older").await;
    server.advance(60);
    let left = create_api_token(&server, &session, "Same time").await;
    let right = create_api_token(&server, &session, "Same time").await;
    assert_ne!(older["created_at"], left["created_at"]);
    assert_eq!(left["created_at"], right["created_at"]);

    let mut tied = [left["id"].as_str().unwrap(), right["id"].as_str().unwrap()];
    tied.sort();
    let expected = [tied[0], tied[1], older["id"].as_str().unwrap()];
    let tokens = api_tokens(&server, &session).await;
    let actual: Vec<_> = tokens
        .as_array()
        .unwrap()
        .iter()
        .map(|token| token["id"].as_str().unwrap())
        .collect();
    assert_eq!(actual, expected);
}
