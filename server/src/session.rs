//! Browser sessions: a signed, expiring cookie issued in exchange for the server token.

use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::{HeaderMap, header};
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

pub const COOKIE: &str = "pensieve_session";
const MAX_AGE: u64 = 30 * 24 * 60 * 60;

/// `Set-Cookie` value for a new session. Signed with the server token, so changing the token
/// ends every session.
pub fn issue(token: &str, headers: &HeaderMap) -> String {
    let expires = now() + MAX_AGE;
    // Tailscale Serve terminates TLS and says so in this header; plain loopback HTTP can't use Secure.
    let secure = headers
        .get("x-forwarded-proto")
        .is_some_and(|v| v == "https");
    format!(
        "{COOKIE}={}; Path=/; Max-Age={MAX_AGE}; HttpOnly; SameSite=Strict{}",
        value(token, expires),
        if secure { "; Secure" } else { "" }
    )
}

pub fn clear() -> String {
    format!("{COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict")
}

/// Whether the request carries an unexpired session cookie signed with `token`.
pub fn valid(token: &str, headers: &HeaderMap) -> bool {
    let Some(cookie) = cookie(headers) else {
        return false;
    };
    let Some(expires) = cookie
        .split_once('.')
        .and_then(|(expires, _)| expires.parse::<u64>().ok())
    else {
        return false;
    };
    expires > now() && bool::from(value(token, expires).as_bytes().ct_eq(cookie.as_bytes()))
}

fn value(token: &str, expires: u64) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes())
        .expect("internal error: HMAC takes any key length");
    mac.update(format!("pensieve-session:{expires}").as_bytes());
    let signature: String = mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("{expires}.{signature}")
}

fn cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|pair| pair.trim().strip_prefix(COOKIE)?.strip_prefix('='))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_cookie(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, format!("other=1; {value}").parse().unwrap());
        headers
    }

    #[test]
    fn sessions_are_signed_expiring_and_tied_to_the_token() {
        let issued = issue("secret-token-123456", &HeaderMap::new());
        assert!(
            issued.contains("HttpOnly")
                && issued.contains("SameSite=Strict")
                && !issued.contains("Secure")
        );
        let pair = issued.split(';').next().unwrap();
        assert!(valid("secret-token-123456", &with_cookie(pair)));
        assert!(
            !valid("rotated-token-123456", &with_cookie(pair)),
            "a new token ends old sessions"
        );

        let (expires, signature) = pair
            .strip_prefix("pensieve_session=")
            .unwrap()
            .split_once('.')
            .unwrap();
        let later = expires.parse::<u64>().unwrap() + 1;
        assert!(
            !valid(
                "secret-token-123456",
                &with_cookie(&format!("{COOKIE}={later}.{signature}"))
            ),
            "expiry is signed"
        );
        let expired = format!("{COOKIE}={}", value("secret-token-123456", now() - 1));
        assert!(!valid("secret-token-123456", &with_cookie(&expired)));
        assert!(!valid("secret-token-123456", &HeaderMap::new()));

        let mut https = HeaderMap::new();
        https.insert("x-forwarded-proto", "https".parse().unwrap());
        assert!(issue("secret-token-123456", &https).ends_with("; Secure"));
    }
}
