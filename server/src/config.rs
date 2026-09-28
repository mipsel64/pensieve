use std::{
    env, fs,
    io::ErrorKind,
    net::SocketAddr,
    path::{Path, PathBuf},
};

use serde::{Deserialize, de::IntoDeserializer};

use crate::rerank::jev::Provider;

/// Server settings from a TOML file, overridden by `PENSIEVE_*` environment variables.
#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub server: ServerConfig,
    pub storage: StorageConfig,
    pub jev: JevConfig,
}

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    pub listen: SocketAddr,
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

    fn parse(text: &str, dir: &Path) -> Result<Self, toml::de::Error> {
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
