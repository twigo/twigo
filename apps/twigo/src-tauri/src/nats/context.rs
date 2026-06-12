use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::error::{self, Error};

#[allow(dead_code)]
#[derive(Debug, Default, Clone, Deserialize)]
pub(crate) struct ContextFile {
    #[serde(default)]
    pub(crate) description: String,
    #[serde(default)]
    pub(crate) url: String,
    #[serde(default)]
    pub(crate) token: Option<String>,
    #[serde(default)]
    pub(crate) user: Option<String>,
    #[serde(default)]
    pub(crate) password: Option<String>,
    #[serde(default)]
    pub(crate) creds: Option<String>,
    #[serde(default)]
    pub(crate) nkey: Option<String>,
    #[serde(default)]
    pub(crate) cert: Option<String>,
    #[serde(default)]
    pub(crate) key: Option<String>,
    #[serde(default)]
    pub(crate) ca: Option<String>,
    #[serde(default)]
    pub(crate) jetstream_domain: Option<String>,
    #[serde(default)]
    pub(crate) jetstream_api_prefix: Option<String>,
    // Twigo extension: HTTP monitoring URL (:8222) for servers without a
    // system-account ($SYS) login — enables the Monitoring view over HTTP.
    #[serde(default)]
    pub(crate) monitoring_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NatsContext {
    pub name: String,
    pub(crate) file: ContextFile,
    pub selected: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSummary {
    pub name: String,
    pub description: String,
    pub url: String,
    pub auth_method: String,
    pub has_tls: bool,
    pub selected: bool,
    pub monitoring_url: Option<String>,
}

impl NatsContext {
    fn auth_method(&self) -> &'static str {
        let f = &self.file;
        if f.creds.is_some() {
            "creds"
        } else if f.nkey.is_some() {
            "nkey"
        } else if f.token.is_some() {
            "token"
        } else if f.user.is_some() {
            "user/password"
        } else {
            "none"
        }
    }

    pub fn summary(&self) -> ContextSummary {
        ContextSummary {
            name: self.name.clone(),
            description: self.file.description.clone(),
            url: self.file.url.clone(),
            auth_method: self.auth_method().to_string(),
            has_tls: self.file.cert.is_some() || self.file.ca.is_some(),
            selected: self.selected,
            monitoring_url: self.file.monitoring_url.clone(),
        }
    }
}

// NATS uses XDG even on macOS, so don't use dirs::config_dir() here.
fn nats_config_dir() -> Option<PathBuf> {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return Some(PathBuf::from(xdg).join("nats"));
        }
    }
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".config").join("nats"))
}

fn selected_context_name(config_dir: &std::path::Path) -> Option<String> {
    let txt = std::fs::read_to_string(config_dir.join("context.txt")).ok()?;
    let name = txt.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

pub fn load_contexts(custom_dir: Option<PathBuf>) -> error::Result<Vec<NatsContext>> {
    let base = match custom_dir {
        Some(d) => d,
        None => match nats_config_dir() {
            Some(d) => d,
            None => return Ok(vec![]),
        },
    };

    let context_dir = if base.join("context").is_dir() {
        base.join("context")
    } else {
        base.clone()
    };
    if !context_dir.is_dir() {
        return Ok(vec![]);
    }

    let selected = selected_context_name(&base);

    let mut contexts = Vec::new();
    let entries = std::fs::read_dir(&context_dir).map_err(|source| Error::Io {
        path: context_dir.display().to_string(),
        source,
    })?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
            continue;
        };
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(file) = serde_json::from_str::<ContextFile>(&raw) else {
            continue;
        };
        let is_selected = selected.as_deref() == Some(name.as_str());
        contexts.push(NatsContext {
            name,
            file,
            selected: is_selected,
        });
    }

    contexts.sort_by_key(|c| c.name.to_lowercase());
    Ok(contexts)
}

#[tauri::command]
pub fn list_contexts(dir: Option<String>) -> error::Result<Vec<ContextSummary>> {
    let custom = dir.filter(|d| !d.trim().is_empty()).map(PathBuf::from);
    Ok(load_contexts(custom)?.iter().map(|c| c.summary()).collect())
}

#[tauri::command]
pub fn default_context_dir() -> Option<String> {
    nats_config_dir().map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn ctx(file: ContextFile) -> NatsContext {
        NatsContext {
            name: "x".into(),
            file,
            selected: false,
        }
    }

    #[test]
    fn auth_method_precedence() {
        let mut f = ContextFile::default();
        assert_eq!(ctx(f.clone()).auth_method(), "none");
        f.user = Some("u".into());
        assert_eq!(ctx(f.clone()).auth_method(), "user/password");
        f.token = Some("t".into());
        assert_eq!(ctx(f.clone()).auth_method(), "token");
        f.nkey = Some("n".into());
        assert_eq!(ctx(f.clone()).auth_method(), "nkey");
        f.creds = Some("/c".into());
        assert_eq!(ctx(f).auth_method(), "creds");
    }

    #[test]
    fn loads_sorts_and_marks_selected() {
        let dir = tempfile::tempdir().unwrap();
        let cdir = dir.path().join("context");
        fs::create_dir_all(&cdir).unwrap();
        fs::write(
            cdir.join("beta.json"),
            r#"{"url":"nats://b:4222","token":"x"}"#,
        )
        .unwrap();
        fs::write(cdir.join("alpha.json"), r#"{"url":"nats://a:4222"}"#).unwrap();
        fs::write(cdir.join("broken.json"), "{ not json").unwrap();
        fs::write(dir.path().join("context.txt"), "beta\n").unwrap();

        let ctxs = load_contexts(Some(dir.path().to_path_buf())).unwrap();

        assert_eq!(ctxs.len(), 2, "malformed file is skipped");
        assert_eq!(ctxs[0].name, "alpha");
        assert_eq!(ctxs[1].name, "beta");
        assert!(ctxs[1].selected);
        assert!(!ctxs[0].selected);
        assert_eq!(ctxs[1].summary().auth_method, "token");
        assert_eq!(ctxs[0].summary().auth_method, "none");
    }

    #[test]
    fn missing_dir_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let ctxs = load_contexts(Some(dir.path().join("does-not-exist"))).unwrap();
        assert!(ctxs.is_empty());
    }
}
