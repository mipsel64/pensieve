use std::{
    env, fmt, fs,
    io::ErrorKind,
    net::SocketAddr,
    path::{Path, PathBuf},
    str::FromStr,
};

use serde::{Deserialize, Deserializer, de::IntoDeserializer};
use url::Url;

use crate::rerank::jev::Provider;

/// Server settings from a TOML file, overridden by `PENSIEVE_*` environment variables.
#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub server: ServerConfig,
    pub storage: StorageConfig,
    pub jev: JevConfig,
    pub oauth: OAuthConfig,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AuthMode {
    #[default]
    Token,
    OAuth,
    Both,
}

impl AuthMode {
    pub fn token(self) -> bool {
        matches!(self, Self::Token | Self::Both)
    }

    pub fn oauth(self) -> bool {
        matches!(self, Self::OAuth | Self::Both)
    }
}

impl FromStr for AuthMode {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "token" => Ok(Self::Token),
            "oauth" => Ok(Self::OAuth),
            "both" => Ok(Self::Both),
            _ => Err(format!(
                "cannot parse auth mode {value:?}: expected token, oauth, or both"
            )),
        }
    }
}

impl fmt::Display for AuthMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Token => "token",
            Self::OAuth => "oauth",
            Self::Both => "both",
        })
    }
}

impl<'de> Deserialize<'de> for AuthMode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct OAuthConfig {
    pub public_url: String,
    pub google_client_id: String,
    pub google_client_secret: String,
    pub allowed_emails: Vec<String>,
}

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    pub listen: SocketAddr,
    pub auth: AuthMode,
    pub token: String,
}

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct StorageConfig {
    /// SQLite database file.
    pub path: PathBuf,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct JevConfig {
    pub provider: Provider,
    /// Enables Jev reranking when set and non-empty.
    pub key: Option<String>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            listen: SocketAddr::from(([127, 0, 0, 1], 7878)),
            auth: AuthMode::Token,
            token: String::new(),
        }
    }
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            path: home().join(".local/share/pensieve/pensieve.db"),
        }
    }
}

impl Config {
    /// Reads `path`, or `~/.config/pensieve/config.toml` when `None`. Only the default file may be missing.
    pub fn load(path: Option<&Path>) -> Result<Self, String> {
        let default = home().join(".config/pensieve/config.toml");
        let file = path.unwrap_or(&default);
        let mut config = match fs::read_to_string(file) {
            Ok(text) => Self::parse(&text, file.parent().unwrap_or(Path::new("")))
                .map_err(|e| format!("cannot parse {}: {e}", file.display()))?,
            Err(e) if e.kind() == ErrorKind::NotFound && path.is_none() => Self::default(),
            Err(e) => return Err(format!("cannot read {}: {e}", file.display())),
        };
        config.apply_env()?;
        Ok(config)
    }

    pub(crate) fn parse(text: &str, dir: &Path) -> Result<Self, toml::de::Error> {
        let mut config: Self = toml::from_str(text)?;
        // Services start in `/`, so relative paths follow the config file instead.
        config.storage.path = dir.join(&config.storage.path);
        Ok(config)
    }

    fn apply_env(&mut self) -> Result<(), String> {
        if let Some(listen) = var("PENSIEVE_LISTEN") {
            self.server.listen = listen
                .parse()
                .map_err(|e| format!("cannot parse PENSIEVE_LISTEN: {e}"))?;
        }
        if let Some(token) = var("PENSIEVE_TOKEN") {
            self.server.token = token;
        }
        if let Some(auth) = var("PENSIEVE_AUTH") {
            self.server.auth = auth
                .parse()
                .map_err(|e| format!("cannot parse PENSIEVE_AUTH: {e}"))?;
        }
        if let Some(public_url) = var("PENSIEVE_PUBLIC_URL") {
            self.oauth.public_url = public_url;
        }
        if let Some(client_id) = var("PENSIEVE_GOOGLE_CLIENT_ID") {
            self.oauth.google_client_id = client_id;
        }
        if let Some(client_secret) = var("PENSIEVE_GOOGLE_CLIENT_SECRET") {
            self.oauth.google_client_secret = client_secret;
        }
        if let Some(emails) = var("PENSIEVE_ALLOWED_EMAILS") {
            self.oauth.allowed_emails = emails
                .split(',')
                .map(str::trim)
                .filter(|email| !email.is_empty())
                .map(str::to_owned)
                .collect();
        }
        if let Some(path) = var("PENSIEVE_DB") {
            self.storage.path = path.into();
        }
        if let Some(key) = var("PENSIEVE_JEV_KEY") {
            self.jev.key = Some(key);
        }
        if let Some(provider) = var("PENSIEVE_JEV_PROVIDER") {
            self.jev.provider = Provider::deserialize(provider.as_str().into_deserializer())
                .map_err(|e: serde::de::value::Error| {
                    format!("cannot parse PENSIEVE_JEV_PROVIDER: {e}")
                })?;
        }
        Ok(())
    }

    /// Checks the settings that `serve` needs for the selected authentication methods.
    pub fn validate(&self) -> Result<(), String> {
        if self.server.auth.token() && self.server.token.len() < 16 {
            return Err(
                "cannot start: server.token (or PENSIEVE_TOKEN) must be at least 16 characters"
                    .into(),
            );
        }
        if !self.server.auth.oauth() {
            return Ok(());
        }
        let oauth = &self.oauth;
        let valid_url = Url::parse(&oauth.public_url).is_ok_and(|url| {
            let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
            let origin = oauth
                .public_url
                .strip_suffix('/')
                .unwrap_or(&oauth.public_url);
            (url.scheme() == "https" || (url.scheme() == "http" && loopback))
                // The issuer and callback URLs are built from this string, so it must already be canonical.
                && url.origin().ascii_serialization() == origin
        });
        if !valid_url {
            return Err("cannot start: oauth.public_url (or PENSIEVE_PUBLIC_URL) must be an origin such as https://my-server.tailnet.ts.net: HTTPS, or HTTP on localhost, lowercase, with no user info, path, query, or fragment".into());
        }
        if oauth.google_client_id.is_empty() {
            return Err(
                "cannot start: oauth.google_client_id (or PENSIEVE_GOOGLE_CLIENT_ID) is required"
                    .into(),
            );
        }
        if oauth.google_client_secret.is_empty() {
            return Err("cannot start: oauth.google_client_secret (or PENSIEVE_GOOGLE_CLIENT_SECRET) is required".into());
        }
        if oauth.allowed_emails.is_empty() {
            return Err("cannot start: oauth.allowed_emails (or PENSIEVE_ALLOWED_EMAILS) must contain at least one email".into());
        }
        if oauth
            .allowed_emails
            .iter()
            .any(|email| !email.bytes().all(|b| (0x21..=0x7e).contains(&b)) || !email.contains('@'))
        {
            return Err(
                "cannot start: oauth.allowed_emails entries must use printable ASCII and contain @"
                    .into(),
            );
        }
        Ok(())
    }
}

/// Empty counts as unset, so `KEY=` in an env file doesn't override the config file.
fn var(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.is_empty())
}

fn home() -> PathBuf {
    env::home_dir().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn example_parses_and_paths_follow_the_file() {
        let example = Config::parse(
            include_str!("../../pensieve.example.toml"),
            Path::new("/etc/pensieve"),
        )
        .unwrap();
        assert_eq!(
            example.server.listen,
            SocketAddr::from(([127, 0, 0, 1], 7878))
        );
        assert!(
            example
                .storage
                .path
                .ends_with(".local/share/pensieve/pensieve.db")
        );

        let custom =
            "[storage]\npath = \"data/p.db\"\n[jev]\nprovider = \"openrouter\"\nkey = \"k\"";
        let config = Config::parse(custom, Path::new("/etc/pensieve")).unwrap();
        assert_eq!(config.storage.path, Path::new("/etc/pensieve/data/p.db"));
        assert!(matches!(config.jev.provider, Provider::Openrouter));
        assert_eq!(config.jev.key.as_deref(), Some("k"));

        assert!(Config::parse("[server]\ntokn = \"typo\"", Path::new("")).is_err());
    }
}
