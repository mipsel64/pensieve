//! Browser sessions: signed, expiring cookies for token and Google sign-in.

use axum::http::{HeaderMap, header};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

pub const COOKIE: &str = "pensieve_session";
const MAX_AGE: i64 = 30 * 24 * 60 * 60;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Subject {
    Token,
    Email(String),
}

pub fn issue_token(key: &[u8; 32], token: &str, headers: &HeaderMap, now: i64) -> String {
    issue(key, &Subject::Token, token, headers, now)
}

pub fn issue_email(key: &[u8; 32], email: &str, headers: &HeaderMap, now: i64) -> String {
    issue(
        key,
        &Subject::Email(email.to_ascii_lowercase()),
        "",
        headers,
        now,
    )
}

fn issue(
    key: &[u8; 32],
    subject: &Subject,
    server_token: &str,
    headers: &HeaderMap,
    now: i64,
) -> String {
    let expires = now + MAX_AGE;
    let subject = match subject {
        Subject::Token => "token".to_owned(),
        Subject::Email(email) => format!("email:{email}"),
    };
    format!(
        "{COOKIE}={}; Path=/; Max-Age={MAX_AGE}; HttpOnly; SameSite=Lax{}",
        value(key, server_token, expires, &subject),
        if secure(headers) { "; Secure" } else { "" }
    )
}

pub fn clear(headers: &HeaderMap) -> String {
    format!(
        "{COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax{}",
        if secure(headers) { "; Secure" } else { "" }
    )
}

/// Returns the valid session subject. Duplicate session cookies are invalid.
pub fn verify(
    key: &[u8; 32],
    server_token: Option<&str>,
    oauth: bool,
    headers: &HeaderMap,
    now: i64,
) -> Option<Subject> {
    let cookie = cookie_value(headers, COOKIE)?;
    let mut parts = cookie.split('.');
    let (Some(expires), Some(encoded), Some(_signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    let expires = expires.parse::<i64>().ok()?;
    if now >= expires {
        return None;
    }
    let raw_subject = String::from_utf8(URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()?;
    let (subject, bound) = match raw_subject.as_str() {
        "token" => (Subject::Token, server_token?),
        value => {
            let email = value.strip_prefix("email:")?;
            if !oauth || email.is_empty() || email.to_ascii_lowercase() != email {
                return None;
            }
            (Subject::Email(email.to_owned()), "")
        }
    };
    let expected = value(key, bound, expires, &raw_subject);
    bool::from(expected.as_bytes().ct_eq(cookie.as_bytes())).then_some(subject)
}

fn value(key: &[u8; 32], server_token: &str, expires: i64, subject: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(key).expect("internal error: HMAC takes any key length");
    mac.update(b"pensieve-session\n");
    mac.update(expires.to_string().as_bytes());
    mac.update(b"\n");
    mac.update(subject.as_bytes());
    mac.update(b"\n");
    mac.update(server_token.as_bytes());
    let signature: String = mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("{expires}.{}.{signature}", URL_SAFE_NO_PAD.encode(subject))
}

pub(crate) fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut found = None;
    for pair in headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
    {
        let Some((key, value)) = pair.trim().split_once('=') else {
            continue;
        };
        if key == name {
            if found.is_some() {
                return None;
            }
            found = Some(value);
        }
    }
    found
}

pub(crate) fn secure(headers: &HeaderMap) -> bool {
    // Tailscale Serve terminates TLS and says so in this header; plain loopback HTTP can't use Secure.
    headers
        .get("x-forwarded-proto")
        .is_some_and(|v| v == "https")
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [7; 32];
    const TOKEN: &str = "secret-token-123456";

    fn with_cookie(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, format!("other=1; {value}").parse().unwrap());
        headers
    }

    #[test]
    fn sessions_bind_the_subject_mode_key_and_server_token() {
        let issued = issue_token(&KEY, TOKEN, &HeaderMap::new(), 100);
        assert!(issued.contains("HttpOnly") && issued.contains("SameSite=Lax"));
        assert!(!issued.contains("Secure"));
        let pair = issued.split(';').next().unwrap();
        assert_eq!(
            verify(&KEY, Some(TOKEN), false, &with_cookie(pair), 101),
            Some(Subject::Token)
        );
        assert_eq!(
            verify(
                &KEY,
                Some("rotated-token-123456"),
                false,
                &with_cookie(pair),
                101
            ),
            None
        );
        assert_eq!(verify(&KEY, None, true, &with_cookie(pair), 101), None);
        assert!(verify(&KEY, Some(TOKEN), false, &with_cookie(pair), 100 + MAX_AGE).is_none());

        let duplicate = with_cookie(&format!("{pair}; {pair}"));
        assert_eq!(verify(&KEY, Some(TOKEN), false, &duplicate, 101), None);

        let email = issue_email(&KEY, "Me@Example.com", &HeaderMap::new(), 100);
        let pair = email.split(';').next().unwrap();
        assert_eq!(
            verify(&KEY, None, true, &with_cookie(pair), 101),
            Some(Subject::Email("me@example.com".into()))
        );
        assert_eq!(
            verify(&KEY, Some(TOKEN), false, &with_cookie(pair), 101),
            None
        );
    }

    #[test]
    fn secure_and_clear_follow_the_proxy_protocol() {
        let mut https = HeaderMap::new();
        https.insert("x-forwarded-proto", "https".parse().unwrap());
        assert!(issue_token(&KEY, TOKEN, &https, 100).ends_with("; Secure"));
        let cleared = clear(&https);
        assert!(cleared.contains("Max-Age=0"));
        assert!(cleared.contains("SameSite=Lax"));
        assert!(cleared.ends_with("; Secure"));
    }
}
