use std::{collections::HashSet, sync::Arc};

use axum::{
    Json, Router,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use url::Url;

use super::{
    AuthorizationCode, OAuth, PendingConsent, params, random, read_body, token_hash, value,
};
use crate::{
    server::App,
    session::{self, Subject},
    storage::{OAuthClient, OAuthToken, TokenKind},
};

pub(super) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/register", post(register))
        .route("/authorize", get(authorize_get).post(authorize_post))
        .route("/token", post(token))
}

async fn register(State(app): State<Arc<App>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let body = match read_body(body).await {
        Ok(body) => body,
        Err(status) => {
            return json_error(
                status,
                "invalid_request",
                "cannot read a registration body of at most 16 KiB",
            );
        }
    };
    if !content_type(&parts.headers, "application/json") {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid_client_metadata",
            "cannot register without application/json",
        );
    }
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return invalid_metadata("cannot parse client metadata as a JSON object");
    };
    let Some(object) = body.as_object() else {
        return invalid_metadata("cannot parse client metadata as a JSON object");
    };
    let Some(redirect_uris) = object.get("redirect_uris").and_then(Value::as_array) else {
        return invalid_metadata("cannot register without redirect_uris");
    };
    if redirect_uris.is_empty() || redirect_uris.len() > 10 {
        return invalid_metadata("cannot register without 1 to 10 redirect URIs");
    }
    let mut uris = Vec::with_capacity(redirect_uris.len());
    for uri in redirect_uris {
        let Some(uri) = uri.as_str() else {
            return invalid_metadata("cannot register a non-string redirect URI");
        };
        if uri.len() > 2000 || !valid_redirect(uri) {
            return json_error(
                StatusCode::BAD_REQUEST,
                "invalid_redirect_uri",
                "cannot register this redirect URI",
            );
        }
        uris.push(uri.to_owned());
    }
    let name = match object.get("client_name") {
        None => "Unnamed app".to_owned(),
        Some(Value::String(name)) if name.trim().chars().count() <= 200 => name.trim().to_owned(),
        _ => return invalid_metadata("cannot use this client_name"),
    };
    let now = (app.clock)();
    let client = OAuthClient {
        id: random(16),
        name,
        redirect_uris: uris,
        created_at: now,
    };
    if let Err(error) = app.storage.register_client(&client, now - 86400).await {
        return oauth_storage_error(error);
    }
    json_response(
        StatusCode::CREATED,
        json!({
            "client_id": client.id,
            "client_id_issued_at": client.created_at,
            "client_name": client.name,
            "redirect_uris": client.redirect_uris,
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        }),
    )
}

fn repeated(params: &[(String, String)], name: &str) -> bool {
    params.iter().filter(|(key, _)| key == name).count() > 1
}

fn valid_redirect(uri: &str) -> bool {
    Url::parse(uri).is_ok_and(|url| {
        let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        url.has_host()
            && (url.scheme() == "https" || (url.scheme() == "http" && loopback))
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
    })
}

async fn authorize_get(State(app): State<Arc<App>>, headers: HeaderMap, uri: Uri) -> Response {
    let oauth = app.oauth.as_ref().expect("OAuth routes require OAuth");
    let query = params(uri.query());
    if repeated(&query, "client_id") || repeated(&query, "redirect_uri") {
        return html_error(
            StatusCode::BAD_REQUEST,
            "cannot repeat client_id or redirect_uri",
        );
    }
    let Some(client_id) = value(&query, "client_id") else {
        return html_error(
            StatusCode::BAD_REQUEST,
            "cannot authorize without client_id",
        );
    };
    let client = match app.storage.client(client_id).await {
        Ok(Some(client)) => client,
        Ok(None) => return html_error(StatusCode::BAD_REQUEST, "cannot find this OAuth client"),
        Err(error) => return html_storage_error(error),
    };
    let requested_redirect = value(&query, "redirect_uri");
    let redirect_uri = match requested_redirect {
        Some(uri) if valid_redirect(uri) && redirect_matches(&client, uri) => uri.to_owned(),
        Some(_) => return html_error(StatusCode::BAD_REQUEST, "cannot use this redirect_uri"),
        None if client.redirect_uris.len() == 1 => client.redirect_uris[0].clone(),
        None => return html_error(StatusCode::BAD_REQUEST, "cannot choose a redirect_uri"),
    };
    let state = value(&query, "state").map(str::to_owned);
    let redirect_error = |error: &str, description: &str| {
        oauth_redirect(
            &redirect_uri,
            &[
                ("error", Some(error)),
                ("error_description", Some(description)),
                ("state", state.as_deref()),
                ("iss", Some(oauth.public_url.as_str())),
            ],
        )
    };
    let mut seen = HashSet::new();
    if query
        .iter()
        .filter(|(name, _)| name != "client_id" && name != "redirect_uri")
        .any(|(name, _)| !seen.insert(name))
    {
        return redirect_error(
            "invalid_request",
            "cannot repeat an authorization parameter",
        );
    }
    if value(&query, "response_type") != Some("code") {
        return redirect_error("unsupported_response_type", "cannot use this response_type");
    }
    let challenge = value(&query, "code_challenge").unwrap_or_default();
    if value(&query, "code_challenge_method") != Some("S256") || !valid_challenge(challenge) {
        return redirect_error("invalid_request", "cannot authorize without S256 PKCE");
    }
    if state.as_ref().is_some_and(|state| state.len() > 1024) {
        return redirect_error("invalid_request", "cannot use a state over 1024 bytes");
    }
    let resource = format!("{}/mcp", oauth.public_url);
    if value(&query, "resource").is_some_and(|value| value != resource) {
        return redirect_error("invalid_target", "cannot authorize this resource");
    }
    let email = session_email(&app, &headers);
    let Some(email) = email else {
        let next = uri
            .path_and_query()
            .map(|value| value.as_str())
            .unwrap_or(uri.path());
        if next.len() > 2000 {
            return html_error(
                StatusCode::BAD_REQUEST,
                "cannot preserve this authorization URL",
            );
        }
        let next = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("next", next)
            .finish();
        return redirect(&format!("/auth/login?{next}"));
    };
    let now = (app.clock)();
    let handle = random(32);
    let pending = PendingConsent {
        client,
        redirect_uri: redirect_uri.clone(),
        challenge: challenge.to_owned(),
        state,
        resource,
        email: email.clone(),
        expires: now + 600,
    };
    let page = consent_page(&handle, &pending.client.name, &redirect_uri, &email);
    {
        let mut entries = oauth.pending.lock().expect("pending consent lock");
        entries.retain(|_, entry| entry.expires > now);
        if entries.len() >= 1024 {
            return html_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "cannot store another pending consent",
            );
        }
        entries.insert(handle.clone(), pending);
    }
    page
}

async fn authorize_post(State(app): State<Arc<App>>, request: Request) -> Response {
    let oauth = app.oauth.as_ref().expect("OAuth routes require OAuth");
    let (parts, body) = request.into_parts();
    if parts
        .headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        != Some(origin(&oauth.public_url).as_str())
    {
        return html_error(StatusCode::FORBIDDEN, "cannot approve from another origin");
    }
    let Some(email) = session_email(&app, &parts.headers) else {
        return html_error(
            StatusCode::FORBIDDEN,
            "cannot approve without a valid session",
        );
    };
    let body = match read_body(body).await {
        Ok(body) => body,
        Err(_) => {
            return html_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "cannot read an authorization form over 16 KiB",
            );
        }
    };
    if !content_type(&parts.headers, "application/x-www-form-urlencoded") {
        return html_error(
            StatusCode::BAD_REQUEST,
            "cannot read this authorization form",
        );
    }
    let form = url::form_urlencoded::parse(&body)
        .into_owned()
        .collect::<Vec<_>>();
    let Some(handle) = value(&form, "handle") else {
        return html_error(StatusCode::BAD_REQUEST, "cannot find this pending consent");
    };
    let now = (app.clock)();
    let pending = oauth
        .pending
        .lock()
        .expect("pending consent lock")
        .remove(handle);
    let Some(pending) = pending.filter(|entry| entry.expires > now && entry.email == email) else {
        return html_error(StatusCode::BAD_REQUEST, "cannot use this pending consent");
    };
    if value(&form, "decision") != Some("approve") {
        return oauth_redirect(
            &pending.redirect_uri,
            &[
                ("error", Some("access_denied")),
                ("state", pending.state.as_deref()),
                ("iss", Some(oauth.public_url.as_str())),
            ],
        );
    }
    let code = random(32);
    let authorization = AuthorizationCode {
        client: pending.client,
        redirect_uri: pending.redirect_uri.clone(),
        challenge: pending.challenge,
        resource: pending.resource,
        email: pending.email,
        expires: now + 600,
    };
    {
        let mut codes = oauth.codes.lock().expect("authorization code lock");
        codes.retain(|_, entry| entry.expires > now);
        if codes.len() >= 1024 {
            return html_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "cannot store another authorization code",
            );
        }
        codes.insert(code.clone(), authorization);
    }
    oauth_redirect(
        &pending.redirect_uri,
        &[
            ("code", Some(&code)),
            ("state", pending.state.as_deref()),
            ("iss", Some(oauth.public_url.as_str())),
        ],
    )
}

async fn token(State(app): State<Arc<App>>, request: Request) -> Response {
    let oauth = app.oauth.as_ref().expect("OAuth routes require OAuth");
    let (parts, body) = request.into_parts();
    let body = match read_body(body).await {
        Ok(body) => body,
        Err(status) => {
            return json_error(
                status,
                "invalid_request",
                "cannot read a token request body of at most 16 KiB",
            );
        }
    };
    if !content_type(&parts.headers, "application/x-www-form-urlencoded") {
        return token_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "cannot read a non-form token request",
            false,
        );
    }
    let form = url::form_urlencoded::parse(&body)
        .into_owned()
        .collect::<Vec<_>>();
    let mut names = HashSet::new();
    if form.iter().any(|(name, _)| !names.insert(name)) {
        return token_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "cannot repeat a token parameter",
            false,
        );
    }
    let basic = basic_client(&parts.headers);
    let grant_type = match value(&form, "grant_type") {
        None => {
            return token_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "cannot exchange without grant_type",
                false,
            );
        }
        Some(grant_type) => grant_type,
    };
    match grant_type {
        "authorization_code" => {
            let (Some(code), Some(verifier)) =
                (value(&form, "code"), value(&form, "code_verifier"))
            else {
                return token_error(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "cannot exchange without code and code_verifier",
                    false,
                );
            };
            let client_id = match token_client(&form, &basic) {
                Ok(client_id) => client_id,
                Err(response) => return *response,
            };
            match known_client(&app, client_id).await {
                Ok(true) => {}
                Ok(false) => return invalid_client(basic.is_some()),
                Err(response) => return *response,
            }
            exchange_code(
                oauth,
                &app,
                code,
                verifier,
                client_id,
                value(&form, "redirect_uri"),
                value(&form, "resource"),
            )
            .await
        }
        "refresh_token" => {
            let Some(refresh_token) = value(&form, "refresh_token") else {
                return token_error(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "cannot refresh without refresh_token",
                    false,
                );
            };
            let client_id = match token_client(&form, &basic) {
                Ok(client_id) => client_id,
                Err(response) => return *response,
            };
            match known_client(&app, client_id).await {
                Ok(true) => {}
                Ok(false) => return invalid_client(basic.is_some()),
                Err(response) => return *response,
            }
            refresh(
                oauth,
                &app,
                refresh_token,
                client_id,
                value(&form, "resource"),
            )
            .await
        }
        _ => token_error(
            StatusCode::BAD_REQUEST,
            "unsupported_grant_type",
            "cannot use this grant_type",
            false,
        ),
    }
}

fn token_client<'a>(
    form: &'a [(String, String)],
    basic: &'a Option<String>,
) -> Result<&'a str, Box<Response>> {
    let form_client = value(form, "client_id");
    if form_client.is_some()
        && basic
            .as_deref()
            .is_some_and(|basic| Some(basic) != form_client)
    {
        return Err(Box::new(token_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "cannot use different client IDs",
            false,
        )));
    }
    form_client.or(basic.as_deref()).ok_or_else(|| {
        Box::new(token_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "cannot exchange without client_id",
            false,
        ))
    })
}

async fn known_client(app: &App, client_id: &str) -> Result<bool, Box<Response>> {
    match app.storage.client(client_id).await {
        Ok(Some(_)) => Ok(true),
        Ok(None) => Ok(false),
        Err(error) => Err(Box::new(oauth_storage_error(error))),
    }
}

async fn exchange_code(
    oauth: &OAuth,
    app: &App,
    code: &str,
    verifier: &str,
    client_id: &str,
    redirect_uri: Option<&str>,
    resource: Option<&str>,
) -> Response {
    let now = (app.clock)();
    let code = oauth
        .codes
        .lock()
        .expect("authorization code lock")
        .remove(code);
    let valid = code.as_ref().is_some_and(|code| {
        code.expires > now
            && code.client.id == client_id
            && redirect_uri.is_none_or(|uri| uri == code.redirect_uri)
            && valid_verifier(verifier)
            && bool::from(
                URL_SAFE_NO_PAD
                    .encode(Sha256::digest(verifier.as_bytes()))
                    .as_bytes()
                    .ct_eq(code.challenge.as_bytes()),
            )
    });
    let Some(code) = code.filter(|_| valid) else {
        return token_error(
            StatusCode::BAD_REQUEST,
            "invalid_grant",
            "cannot use this authorization code",
            false,
        );
    };
    let expected_resource = format!("{}/mcp", oauth.public_url);
    if resource.is_some_and(|resource| resource != expected_resource) {
        return token_error(
            StatusCode::BAD_REQUEST,
            "invalid_target",
            "cannot issue a token for this resource",
            false,
        );
    }
    if code.resource != expected_resource || !oauth.allows(&code.email) {
        return token_error(
            StatusCode::BAD_REQUEST,
            "invalid_grant",
            "cannot use this authorization code",
            false,
        );
    }
    let grant_id = random(16);
    let (access_token, refresh_token, tokens) = token_pair(now);
    if let Err(error) = app
        .storage
        .create_grant(
            &grant_id,
            &code.client.id,
            &code.email,
            &expected_resource,
            &tokens,
            now,
        )
        .await
    {
        return oauth_storage_error(error);
    }
    token_success(access_token, refresh_token)
}

async fn refresh(
    oauth: &OAuth,
    app: &App,
    refresh_token: &str,
    client_id: &str,
    resource: Option<&str>,
) -> Response {
    let now = (app.clock)();
    let hash = token_hash(refresh_token);
    match app
        .storage
        .token_owner(&hash, TokenKind::UsedRefresh, now)
        .await
    {
        Ok(Some(owner)) if owner.client_id == client_id => {
            if let Err(error) = app.storage.revoke_grant(&owner.grant_id).await {
                return oauth_storage_error(error);
            }
            return token_error(
                StatusCode::BAD_REQUEST,
                "invalid_grant",
                "cannot replay a refresh token",
                false,
            );
        }
        Ok(_) => {}
        Err(error) => return oauth_storage_error(error),
    }
    let owner = match app
        .storage
        .token_owner(&hash, TokenKind::Refresh, now)
        .await
    {
        Ok(Some(owner)) if owner.client_id == client_id => owner,
        Ok(_) => {
            match app
                .storage
                .token_owner(&hash, TokenKind::UsedRefresh, now)
                .await
            {
                Ok(Some(owner)) if owner.client_id == client_id => {
                    if let Err(error) = app.storage.revoke_grant(&owner.grant_id).await {
                        return oauth_storage_error(error);
                    }
                }
                Ok(_) => {}
                Err(error) => return oauth_storage_error(error),
            }
            return token_error(
                StatusCode::BAD_REQUEST,
                "invalid_grant",
                "cannot use this refresh token",
                false,
            );
        }
        Err(error) => return oauth_storage_error(error),
    };
    let expected_resource = format!("{}/mcp", oauth.public_url);
    if resource.is_some_and(|resource| resource != expected_resource) {
        return token_error(
            StatusCode::BAD_REQUEST,
            "invalid_target",
            "cannot issue a token for this resource",
            false,
        );
    }
    if owner.resource != expected_resource || !oauth.allows(&owner.email) {
        return token_error(
            StatusCode::BAD_REQUEST,
            "invalid_grant",
            "cannot use this refresh token",
            false,
        );
    }
    let (access_token, new_refresh, tokens) = token_pair(now);
    match app
        .storage
        .rotate_refresh(&hash, client_id, &tokens, now)
        .await
    {
        Ok(Some(_)) => token_success(access_token, new_refresh),
        Ok(None) => {
            match app
                .storage
                .token_owner(&hash, TokenKind::UsedRefresh, now)
                .await
            {
                Ok(Some(owner)) if owner.client_id == client_id => {
                    if let Err(error) = app.storage.revoke_grant(&owner.grant_id).await {
                        return oauth_storage_error(error);
                    }
                }
                Ok(_) => {}
                Err(error) => return oauth_storage_error(error),
            }
            token_error(
                StatusCode::BAD_REQUEST,
                "invalid_grant",
                "cannot use this refresh token",
                false,
            )
        }
        Err(error) => oauth_storage_error(error),
    }
}

fn token_pair(now: i64) -> (String, String, Vec<OAuthToken>) {
    let access = format!("pensieve_at_{}", random(32));
    let refresh = format!("pensieve_rt_{}", random(32));
    let tokens = vec![
        OAuthToken {
            hash: token_hash(&access),
            kind: TokenKind::Access,
            expires_at: now + 3600,
        },
        OAuthToken {
            hash: token_hash(&refresh),
            kind: TokenKind::Refresh,
            expires_at: now + 30 * 86400,
        },
    ];
    (access, refresh, tokens)
}

fn token_success(access_token: String, refresh_token: String) -> Response {
    json_response(
        StatusCode::OK,
        json!({
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": 3600,
            "refresh_token": refresh_token,
            "scope": "pensieve",
        }),
    )
}

fn basic_client(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, encoded) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("basic") {
        return None;
    }
    let decoded = STANDARD.decode(encoded.trim()).ok()?;
    let decoded = String::from_utf8(decoded).ok()?;
    Some(
        decoded
            .split_once(':')
            .map_or(decoded.clone(), |(id, _)| id.to_owned()),
    )
}

fn valid_verifier(value: &str) -> bool {
    (43..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'))
}

/// An S256 challenge is an unpadded base64url SHA-256 digest: exactly 43 characters.
fn valid_challenge(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn redirect_matches(client: &OAuthClient, requested: &str) -> bool {
    client.redirect_uris.iter().any(|registered| {
        if registered == requested {
            return true;
        }
        let (Ok(registered), Ok(requested)) = (Url::parse(registered), Url::parse(requested))
        else {
            return false;
        };
        matches!(
            registered.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]")
        ) && registered.scheme() == "http"
            && requested.scheme() == "http"
            && registered.host_str() == requested.host_str()
            && registered.path() == requested.path()
            && registered.query() == requested.query()
    })
}

fn session_email(app: &App, headers: &HeaderMap) -> Option<String> {
    let oauth = app.oauth.as_ref()?;
    match session::verify(
        &app.session_key,
        app.token.as_deref(),
        true,
        headers,
        (app.clock)(),
    ) {
        Some(Subject::Email(email)) if oauth.allows(&email) => Some(email),
        _ => None,
    }
}

const HTML_STYLE: &str = r#"
:root {
  color-scheme: light;
  --canvas: #faf4e1;
  --surface: #fbf6e6;
  --surface-2: #f1e6c9;
  --border: #dccfae;
  --border-strong: #857a62;
  --text: #3c3836;
  --text-2: #4a4441;
  --muted: #625a51;
  --link: #0a4f5e;
  --accent: #a9d5c2;
  --accent-ink: #282828;
  --danger: #9d0006;
  --mist: rgb(169 213 194 / 0.35);
  --shadow-pop: 0 10px 30px rgb(60 56 54 / 0.1);
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --canvas: #262320;
    --surface: #2b2826;
    --surface-2: #34302c;
    --border: #3f3a35;
    --border-strong: #8a8176;
    --text: #ebdbb2;
    --text-2: #d5c4a1;
    --muted: #b0a18b;
    --link: #8ec5b0;
    --accent: #5fa48d;
    --accent-ink: #1d2021;
    --danger: #fb8a7a;
    --mist: rgb(95 164 141 / 0.25);
    --shadow-pop: 0 0 0 1px #3f3a35, 0 20px 50px rgb(0 0 0 / 0.45);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  color: var(--text);
  font: 14px/1.55 system-ui, -apple-system, 'Segoe UI', sans-serif;
  -webkit-font-smoothing: antialiased;
}
.login {
  display: grid;
  min-height: 100vh;
  min-height: 100svh;
  place-items: center;
  padding: 24px;
  background: radial-gradient(ellipse 50% 40% at 50% 38%, var(--mist), transparent 70%), var(--canvas);
}
.login-card {
  display: flex;
  width: min(400px, 100%);
  flex-direction: column;
  gap: 10px;
  padding: 32px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: color-mix(in srgb, var(--surface) 90%, transparent);
  box-shadow: var(--shadow-pop);
}
h1 {
  margin: 0 0 14px;
  font-size: 22px;
  font-weight: 600;
  line-height: 1.3;
  text-align: center;
  overflow-wrap: anywhere;
}
p { margin: 0; }
strong, code { overflow-wrap: anywhere; }
code { font: 0.92em ui-monospace, SFMono-Regular, Menlo, monospace; }
.muted { color: var(--muted); }
.warning { color: var(--danger); }
form {
  display: flex;
  gap: 10px;
  margin-top: 14px;
}
button {
  border-radius: 6px;
  font: inherit;
  cursor: pointer;
  transition: background-color 150ms, border-color 150ms, color 150ms;
}
.primary, .ghost {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.primary {
  min-height: 42px;
  padding: 0 18px;
  border: 0;
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: 600;
}
.primary:hover { background: color-mix(in srgb, var(--accent) 88%, var(--text)); }
.ghost {
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-2);
}
.ghost:hover {
  border-color: var(--muted);
  background: var(--surface-2);
  color: var(--text);
}
:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}
@media (max-width: 360px) {
  .login { padding: 12px; }
  .login-card { padding: 20px; }
  form { flex-direction: column; }
  .primary, .ghost { width: 100%; }
}
"#;

fn html_document(title: &str, content: &str) -> String {
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{title}</title><style>{HTML_STYLE}</style></head><body><main class=\"login\"><div class=\"login-card\">{content}</div></main></body></html>"
    )
}

fn consent_page(handle: &str, client_name: &str, redirect_uri: &str, email: &str) -> Response {
    let url = Url::parse(redirect_uri).expect("registered redirect URL");
    let host = url.host_str().unwrap_or_default();
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
        && url.scheme() == "http";
    let warning = if loopback {
        "<p class=\"warning\">This app redirects to your local computer.</p>"
    } else {
        ""
    };
    let body = html_document(
        "Connect app · Pensieve",
        &format!(
            r#"<h1>Connect {}</h1><p><strong>{}</strong> registered itself with Pensieve. Pensieve has not verified it.</p><p>It redirects to <code>{}</code>.</p>{}<p>Signed in as <strong>{}</strong>.</p><p>This app can read and change all of Pensieve's memory until you revoke it in Settings.</p><form method="post" action="/authorize"><input type="hidden" name="handle" value="{}"><button class="primary" name="decision" value="approve">Approve</button><button class="ghost" name="decision" value="deny">Deny</button></form>"#,
            escape(client_name),
            escape(client_name),
            escape(host),
            warning,
            escape(email),
            escape(handle),
        ),
    );
    html_response(
        StatusCode::OK,
        body,
        Some(&format!(
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' {}; frame-ancestors 'none'; base-uri 'none'",
            origin(redirect_uri)
        )),
    )
}

fn html_error(status: StatusCode, message: &str) -> Response {
    html_response(
        status,
        html_document(
            "Pensieve",
            &format!("<h1>Cannot authorize</h1><p>{}</p>", escape(message)),
        ),
        None,
    )
}

fn html_response(status: StatusCode, body: String, csp: Option<&str>) -> Response {
    let mut response = (status, body).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    // `no-referrer` makes browsers send `Origin: null` on the consent POST, which the origin check rejects.
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    if let Some(csp) = csp {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_str(csp).expect("cannot create consent CSP"),
        );
    }
    response
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn origin(uri: &str) -> String {
    let url = Url::parse(uri).expect("validated URL");
    format!(
        "{}://{}{}",
        url.scheme(),
        url.host_str().unwrap_or_default(),
        url.port()
            .map(|port| format!(":{port}"))
            .unwrap_or_default()
    )
}

fn oauth_redirect(uri: &str, parameters: &[(&str, Option<&str>)]) -> Response {
    let mut url = Url::parse(uri).expect("registered redirect URL");
    {
        let mut query = url.query_pairs_mut();
        for (name, value) in parameters {
            if let Some(value) = value {
                query.append_pair(name, value);
            }
        }
    }
    redirect(url.as_str())
}

fn redirect(location: &str) -> Response {
    let mut response = StatusCode::FOUND.into_response();
    response.headers_mut().insert(
        header::LOCATION,
        HeaderValue::from_str(location).expect("cannot create OAuth redirect"),
    );
    response
}

fn content_type(headers: &HeaderMap, expected: &str) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case(expected))
}

fn invalid_metadata(description: &str) -> Response {
    json_error(
        StatusCode::BAD_REQUEST,
        "invalid_client_metadata",
        description,
    )
}

fn token_error(status: StatusCode, error: &str, description: &str, basic: bool) -> Response {
    let mut response = json_error(status, error, description);
    if basic {
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            HeaderValue::from_static("Basic realm=\"pensieve\""),
        );
    }
    response
}

fn invalid_client(basic: bool) -> Response {
    token_error(
        StatusCode::UNAUTHORIZED,
        "invalid_client",
        "cannot find this OAuth client",
        basic,
    )
}

fn json_error(status: StatusCode, error: &str, description: &str) -> Response {
    json_response(
        status,
        json!({"error": error, "error_description": description}),
    )
}

fn json_response(status: StatusCode, value: Value) -> Response {
    let mut response = (status, Json(value)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn oauth_storage_error(error: crate::error::Error) -> Response {
    eprintln!("{error}");
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "server_error",
        "cannot access OAuth storage",
    )
}

fn html_storage_error(error: crate::error::Error) -> Response {
    eprintln!("{error}");
    html_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "cannot access OAuth storage",
    )
}
