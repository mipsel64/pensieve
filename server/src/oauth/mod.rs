mod authorize;

#[cfg(test)]
mod tests;

use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::Duration,
};

use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use url::Url;

use crate::{
    server::App,
    session,
    storage::{OAuthClient, Storage, TokenKind},
};

const STATE_COOKIE: &str = "pensieve_oauth_state";
const MAX_BODY: usize = 16 * 1024;

pub struct Google {
    pub client_id: String,
    pub client_secret: String,
    pub auth_url: String,
    pub token_url: String,
}

impl Google {
    pub fn new(client_id: impl Into<String>, client_secret: impl Into<String>) -> Self {
        Self {
            client_id: client_id.into(),
            client_secret: client_secret.into(),
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token_url: "https://oauth2.googleapis.com/token".into(),
        }
    }
}

pub struct OAuth {
    public_url: String,
    google: Google,
    allowed_emails: HashSet<String>,
    http: reqwest::Client,
    pending: Mutex<HashMap<String, PendingConsent>>,
    codes: Mutex<HashMap<String, AuthorizationCode>>,
}

impl OAuth {
    pub fn new(public_url: &str, google: Google, allowed_emails: Vec<String>) -> Self {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .expect("cannot build Google HTTP client");
        Self {
            public_url: public_url.trim_end_matches('/').to_owned(),
            google,
            allowed_emails: allowed_emails
                .into_iter()
                .map(|email| email.trim().to_ascii_lowercase())
                .collect(),
            http,
            pending: Mutex::new(HashMap::new()),
            codes: Mutex::new(HashMap::new()),
        }
    }

    pub fn allows(&self, email: &str) -> bool {
        self.allowed_emails.contains(&email.to_ascii_lowercase())
    }

    pub(crate) fn public_url(&self) -> &str {
        &self.public_url
    }

    pub async fn valid_access(
        &self,
        storage: &dyn Storage,
        token: &str,
        now: i64,
    ) -> crate::error::Result<bool> {
        let owner = storage
            .token_owner(&token_hash(token), TokenKind::Access, now)
            .await?;
        Ok(owner.is_some_and(|owner| {
            owner.resource == format!("{}/mcp", self.public_url) && self.allows(&owner.email)
        }))
    }
}

struct PendingConsent {
    client: OAuthClient,
    redirect_uri: String,
    challenge: String,
    state: Option<String>,
    resource: String,
    email: String,
    expires: i64,
}

struct AuthorizationCode {
    client: OAuthClient,
    redirect_uri: String,
    challenge: String,
    resource: String,
    email: String,
    expires: i64,
}

pub fn routes() -> Router<std::sync::Arc<App>> {
    Router::new()
        .route("/auth/login", get(google_login))
        .route("/auth/callback", get(google_callback))
        .route(
            "/.well-known/oauth-protected-resource",
            get(protected_resource),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(protected_resource),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(authorization_server),
        )
        .merge(authorize::routes())
        .layer(DefaultBodyLimit::disable())
}

async fn protected_resource(State(app): State<std::sync::Arc<App>>) -> Response {
    let oauth = app.oauth.as_ref().expect("OAuth routes require OAuth");
    (
        [(header::CACHE_CONTROL, "no-store")],
        axum::Json(json!({
            "resource": format!("{}/mcp", oauth.public_url),
            "authorization_servers": [oauth.public_url],
            "scopes_supported": ["pensieve"],
            "bearer_methods_supported": ["header"],
            "resource_name": "Pensieve",
        })),
    )
        .into_response()
}

async fn authorization_server(State(app): State<std::sync::Arc<App>>) -> Response {
    let p = &app
        .oauth
        .as_ref()
        .expect("OAuth routes require OAuth")
        .public_url;
    (
        [(header::CACHE_CONTROL, "no-store")],
        axum::Json(json!({
            "issuer": p,
            "authorization_endpoint": format!("{p}/authorize"),
            "token_endpoint": format!("{p}/token"),
            "registration_endpoint": format!("{p}/register"),
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none"],
            "scopes_supported": ["pensieve"],
            "authorization_response_iss_parameter_supported": true,
        })),
    )
        .into_response()
}

#[derive(Serialize, Deserialize)]
struct SignInState {
    state: String,
    nonce: String,
    verifier: String,
    next: String,
    exp: i64,
}

async fn google_login(
    State(app): State<std::sync::Arc<App>>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let oauth = app.oauth.as_ref().expect("OAuth routes require OAuth");
    let next = params(uri.query())
        .into_iter()
        .find(|(name, _)| name == "next")
        .map(|(_, value)| value)
        .filter(|next| {
            next.starts_with("/authorize?")
                && next.len() <= 2000
                && !next.contains('"')
                && !next.contains('\\')
                && next.bytes().all(|b| (0x21..=0x7e).contains(&b))
        })
        .unwrap_or_else(|| "/".into());
    let state = SignInState {
        state: random(32),
        nonce: random(32),
        verifier: random(32),
        next,
        exp: (app.clock)() + 600,
    };
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(state.verifier.as_bytes()));
    let payload = URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&state).expect("cannot serialize Google sign-in state"));
    let signature = state_signature(&app.session_key, &payload);
    let cookie = format!(
        "{STATE_COOKIE}={payload}.{signature}; Path=/auth; Max-Age=600; HttpOnly; SameSite=Lax{}",
        if session::secure(&headers) {
            "; Secure"
        } else {
            ""
        }
    );
    let mut url = match Url::parse(&oauth.google.auth_url) {
        Ok(url) => url,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    url.query_pairs_mut()
        .append_pair("client_id", &oauth.google.client_id)
        .append_pair(
            "redirect_uri",
            &format!("{}/auth/callback", oauth.public_url),
        )
        .append_pair("response_type", "code")
        .append_pair("scope", "openid email")
        .append_pair("state", &state.state)
        .append_pair("nonce", &state.nonce)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("prompt", "select_account");
    let location = url.to_string().replace('+', "%20");
    let mut response = StatusCode::FOUND.into_response();
    if let Ok(value) = HeaderValue::from_str(&location) {
        response.headers_mut().insert(header::LOCATION, value);
    } else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).expect("cannot create state cookie"),
    );
    response
}

async fn google_callback(
    State(app): State<std::sync::Arc<App>>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let oauth = app.oauth.as_ref().expect("OAuth routes require OAuth");
    let query = params(uri.query());
    if query.iter().any(|(name, _)| name == "error") {
        return callback_error(
            &headers,
            StatusCode::BAD_REQUEST,
            "cannot sign in with Google",
        );
    }
    let Some(state) = valid_state(&app, &headers) else {
        return callback_error(
            &headers,
            StatusCode::BAD_REQUEST,
            "cannot validate Google sign-in state",
        );
    };
    let Some(returned) = value(&query, "state") else {
        return callback_error(
            &headers,
            StatusCode::BAD_REQUEST,
            "cannot validate Google sign-in state",
        );
    };
    if !bool::from(returned.as_bytes().ct_eq(state.state.as_bytes())) {
        return callback_error(
            &headers,
            StatusCode::BAD_REQUEST,
            "cannot validate Google sign-in state",
        );
    }
    let Some(code) = value(&query, "code").filter(|code| !code.is_empty()) else {
        return callback_error(
            &headers,
            StatusCode::BAD_REQUEST,
            "cannot sign in without a Google authorization code",
        );
    };
    let exchanged = oauth
        .http
        .post(&oauth.google.token_url)
        .form(&[
            ("code", code),
            ("client_id", oauth.google.client_id.as_str()),
            ("client_secret", oauth.google.client_secret.as_str()),
            (
                "redirect_uri",
                &format!("{}/auth/callback", oauth.public_url),
            ),
            ("grant_type", "authorization_code"),
            ("code_verifier", state.verifier.as_str()),
        ])
        .send()
        .await;
    let Ok(exchanged) = exchanged else {
        return callback_error(
            &headers,
            StatusCode::BAD_GATEWAY,
            "cannot exchange the Google authorization code",
        );
    };
    if !exchanged.status().is_success() {
        return callback_error(
            &headers,
            StatusCode::BAD_GATEWAY,
            "cannot exchange the Google authorization code",
        );
    }
    let Ok(body) = exchanged.json::<Value>().await else {
        return callback_error(
            &headers,
            StatusCode::BAD_GATEWAY,
            "cannot read the Google token response",
        );
    };
    let Some(id_token) = body.get("id_token").and_then(Value::as_str) else {
        return callback_error(
            &headers,
            StatusCode::BAD_GATEWAY,
            "cannot read the Google ID token",
        );
    };
    let Some(claims) = id_token
        .split('.')
        .nth(1)
        .and_then(|claims| URL_SAFE_NO_PAD.decode(claims).ok())
        .and_then(|claims| serde_json::from_slice::<Value>(&claims).ok())
        .filter(Value::is_object)
    else {
        return callback_error(
            &headers,
            StatusCode::BAD_GATEWAY,
            "cannot validate the Google ID token",
        );
    };
    let issuer = claims.get("iss").and_then(Value::as_str);
    if !matches!(
        issuer,
        Some("https://accounts.google.com" | "accounts.google.com")
    ) || claims.get("aud").and_then(Value::as_str) != Some(oauth.google.client_id.as_str())
        || claims
            .get("exp")
            .and_then(Value::as_f64)
            .is_none_or(|exp| exp <= (app.clock)() as f64)
        || claims.get("nonce").and_then(Value::as_str) != Some(state.nonce.as_str())
        || claims
            .get("sub")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        || claims
            .get("email")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    {
        return callback_error(
            &headers,
            StatusCode::BAD_GATEWAY,
            "cannot validate the Google ID token",
        );
    }
    if claims.get("email_verified").and_then(Value::as_bool) != Some(true) {
        return callback_error(
            &headers,
            StatusCode::FORBIDDEN,
            "cannot use an unverified Google email",
        );
    }
    let email = claims["email"].as_str().expect("email was checked");
    if !email.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return callback_error(
            &headers,
            StatusCode::FORBIDDEN,
            "cannot use this Google email",
        );
    }
    let email = email.to_ascii_lowercase();
    if !oauth.allows(&email) {
        return callback_error(
            &headers,
            StatusCode::FORBIDDEN,
            "cannot sign in with this Google email",
        );
    }
    let mut response = StatusCode::FOUND.into_response();
    response.headers_mut().insert(
        header::LOCATION,
        HeaderValue::from_str(&state.next).expect("cannot create sign-in redirect"),
    );
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&session::issue_email(
            &app.session_key,
            &email,
            &headers,
            (app.clock)(),
        ))
        .expect("cannot create session cookie"),
    );
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&clear_state_cookie(&headers)).expect("cannot clear state cookie"),
    );
    response
}

fn valid_state(app: &App, headers: &HeaderMap) -> Option<SignInState> {
    let cookie = session::cookie_value(headers, STATE_COOKIE)?;
    let (payload, signature) = cookie.split_once('.')?;
    if payload.contains('.') || signature.contains('.') {
        return None;
    }
    let expected = state_signature(&app.session_key, payload);
    if !bool::from(expected.as_bytes().ct_eq(signature.as_bytes())) {
        return None;
    }
    let state: SignInState = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    ((app.clock)() < state.exp).then_some(state)
}

fn state_signature(key: &[u8; 32], payload: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(key).expect("internal error: HMAC takes any key length");
    mac.update(b"pensieve-oauth-state\n");
    mac.update(payload.as_bytes());
    hex(&mac.finalize().into_bytes())
}

fn clear_state_cookie(headers: &HeaderMap) -> String {
    format!(
        "{STATE_COOKIE}=; Path=/auth; Max-Age=0; HttpOnly; SameSite=Lax{}",
        if session::secure(headers) {
            "; Secure"
        } else {
            ""
        }
    )
}

fn callback_error(headers: &HeaderMap, status: StatusCode, message: &str) -> Response {
    let mut response = (status, message.to_owned()).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&clear_state_cookie(headers)).expect("cannot clear state cookie"),
    );
    response
}

fn params(query: Option<&str>) -> Vec<(String, String)> {
    url::form_urlencoded::parse(query.unwrap_or_default().as_bytes())
        .into_owned()
        .collect()
}

fn value<'a>(params: &'a [(String, String)], name: &str) -> Option<&'a str> {
    params
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

pub(crate) fn random(size: usize) -> String {
    let mut bytes = vec![0; size];
    getrandom::fill(&mut bytes).expect("cannot generate random bytes");
    URL_SAFE_NO_PAD.encode(bytes)
}

pub(crate) fn token_hash(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

async fn read_body(body: Body) -> Result<Bytes, StatusCode> {
    let bytes = to_bytes(body, MAX_BODY + 1)
        .await
        .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;
    if bytes.len() > MAX_BODY {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    Ok(bytes)
}
