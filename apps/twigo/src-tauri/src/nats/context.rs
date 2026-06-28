use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

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
    // Server does the TLS handshake before sending INFO (vs upgrade after).
    #[serde(default)]
    pub(crate) tls_first: bool,
    #[serde(default)]
    pub(crate) jetstream_domain: Option<String>,
    #[serde(default)]
    pub(crate) jetstream_api_prefix: Option<String>,
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

// The public NATS demo server (demo.nats.io) - core, JetStream and KV are open
// for trying the app with zero setup. Exposed as a synthetic, file-less context
// the user opts into; `connect` recognises this reserved name.
pub const DEMO_CONTEXT_NAME: &str = "demo.nats.io";

pub fn demo_context() -> NatsContext {
    NatsContext {
        name: DEMO_CONTEXT_NAME.to_string(),
        file: ContextFile {
            description: "Public NATS demo server - try core, JetStream and KV.".to_string(),
            url: "nats://demo.nats.io:4222".to_string(),
            ..Default::default()
        },
        selected: false,
    }
}

#[tauri::command]
pub fn list_contexts(
    dir: Option<String>,
    include_demo: bool,
) -> error::Result<Vec<ContextSummary>> {
    let custom = dir.filter(|d| !d.trim().is_empty()).map(PathBuf::from);
    let mut out: Vec<ContextSummary> = load_contexts(custom)?.iter().map(|c| c.summary()).collect();
    if include_demo {
        out.push(demo_context().summary());
    }
    Ok(out)
}

#[tauri::command]
pub fn default_context_dir() -> Option<String> {
    nats_config_dir().map(|p| p.to_string_lossy().into_owned())
}

// Full editable fields for the connection form's edit mode. Includes inline
// secrets (so the form can pre-fill) - the frontend keeps these in local
// component state only, never in a persisted store.
#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextDetail {
    name: String,
    description: String,
    url: String,
    token: Option<String>,
    user: Option<String>,
    password: Option<String>,
    creds: Option<String>,
    nkey: Option<String>,
    ca: Option<String>,
    cert: Option<String>,
    key: Option<String>,
    tls_first: bool,
}

/// Full editable detail of a single context (for the edit form). Errors if the
/// context doesn't exist.
#[tauri::command]
pub fn get_context(dir: Option<String>, name: String) -> error::Result<ContextDetail> {
    let custom = dir.filter(|d| !d.trim().is_empty()).map(PathBuf::from);
    let ctx = load_contexts(custom)?
        .into_iter()
        .find(|c| c.name == name)
        .ok_or_else(|| Error::ContextNotFound(name.clone()))?;
    let f = ctx.file;
    Ok(ContextDetail {
        name: ctx.name,
        description: f.description,
        url: f.url,
        token: f.token,
        user: f.user,
        password: f.password,
        creds: f.creds,
        nkey: f.nkey,
        ca: f.ca,
        cert: f.cert,
        key: f.key,
        tls_first: f.tls_first,
    })
}

// The fields the connection form manages. Secrets are written inline into the
// context JSON exactly like the nats CLI does (full CLI<->GUI round-trip);
// file-path auth (creds/nkey) is preferred and never stores a raw secret.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextInput {
    #[serde(default)]
    description: Option<String>,
    url: String,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    creds: Option<String>,
    #[serde(default)]
    nkey: Option<String>,
    #[serde(default)]
    ca: Option<String>,
    #[serde(default)]
    cert: Option<String>,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    tls_first: bool,
}

// A context name becomes a file name (<name>.json), so it must stay a single
// path segment - reject anything that could traverse out of the context dir.
fn valid_context_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name != "."
        && name != ".."
        && !name.contains("..")
        && name != DEMO_CONTEXT_NAME // reserved synthetic context
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn base_dir(dir: Option<String>) -> error::Result<PathBuf> {
    dir.filter(|d| !d.trim().is_empty())
        .map(PathBuf::from)
        .or_else(nats_config_dir)
        .ok_or_else(|| Error::ContextNotFound("no context directory".into()))
}

// Where to write a context file: prefer an existing context/ subdir, else a flat
// base that already holds contexts, else the CLI-standard context/ (created).
fn context_write_dir(base: &Path) -> PathBuf {
    let sub = base.join("context");
    if sub.is_dir() {
        return sub;
    }
    let base_has_json = std::fs::read_dir(base)
        .map(|rd| {
            rd.flatten()
                .any(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        })
        .unwrap_or(false);
    if base_has_json {
        base.to_path_buf()
    } else {
        sub
    }
}

// Set a string field when non-empty, otherwise drop it - so switching auth
// method (e.g. token -> user/password) clears the now-stale secret.
fn put(obj: &mut serde_json::Map<String, serde_json::Value>, key: &str, val: Option<String>) {
    match val.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(v) => {
            obj.insert(key.to_string(), serde_json::Value::String(v));
        }
        None => {
            obj.remove(key);
        }
    }
}

// Write owner-only and atomically (temp + rename) so a crash mid-write can't
// leave a half-written context, and the file (which may hold a secret) isn't
// world-readable.
fn write_context_file(path: &Path, contents: &str) -> error::Result<()> {
    let io_err = |source| Error::Io {
        path: path.display().to_string(),
        source,
    };
    let tmp = path.with_extension("json.twigo-tmp");
    std::fs::write(&tmp, contents).map_err(io_err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path).map_err(io_err)
}

/// Create or update a nats context, writing the standard CLI JSON format so the
/// context round-trips with the `nats` CLI. Unknown fields in an existing file
/// are preserved.
#[tauri::command]
pub fn save_context(dir: Option<String>, name: String, input: ContextInput) -> error::Result<()> {
    if !valid_context_name(&name) {
        return Err(Error::Credentials(format!("invalid context name '{name}'")));
    }
    let base = base_dir(dir)?;
    let cdir = context_write_dir(&base);
    std::fs::create_dir_all(&cdir).map_err(|source| Error::Io {
        path: cdir.display().to_string(),
        source,
    })?;
    let path = cdir.join(format!("{name}.json"));

    // Merge onto the existing file so fields Twigo doesn't model are kept.
    let mut obj: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    put(&mut obj, "description", input.description);
    obj.insert(
        "url".to_string(),
        serde_json::Value::String(input.url.trim().to_string()),
    );
    put(&mut obj, "token", input.token);
    put(&mut obj, "user", input.user);
    put(&mut obj, "password", input.password);
    put(&mut obj, "creds", input.creds);
    put(&mut obj, "nkey", input.nkey);
    put(&mut obj, "ca", input.ca);
    put(&mut obj, "cert", input.cert);
    put(&mut obj, "key", input.key);
    obj.insert(
        "tls_first".to_string(),
        serde_json::Value::Bool(input.tls_first),
    );

    let json = serde_json::to_string_pretty(&obj).map_err(|e| Error::Task(e.to_string()))?;
    write_context_file(&path, &json)
}

/// Delete a context file. Clears the CLI selection (context.txt) if it pointed
/// at the deleted context.
#[tauri::command]
pub fn delete_context(dir: Option<String>, name: String) -> error::Result<()> {
    if !valid_context_name(&name) {
        return Err(Error::Credentials(format!("invalid context name '{name}'")));
    }
    let base = base_dir(dir)?;
    let cdir = context_write_dir(&base);
    let path = cdir.join(format!("{name}.json"));
    std::fs::remove_file(&path).map_err(|source| Error::Io {
        path: path.display().to_string(),
        source,
    })?;
    if selected_context_name(&base).as_deref() == Some(name.as_str()) {
        let _ = std::fs::remove_file(base.join("context.txt"));
    }
    Ok(())
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
    fn tls_fields_parse_and_summarize() {
        let plain: ContextFile = serde_json::from_str(r#"{"url":"nats://x:4222"}"#).unwrap();
        assert!(!plain.tls_first, "tls_first defaults to false when absent");
        assert!(!ctx(plain).summary().has_tls);

        let tls: ContextFile = serde_json::from_str(
            r#"{"url":"tls://x:4222","ca":"/ca.pem","cert":"/c.pem","key":"/k.pem","tls_first":true}"#,
        )
        .unwrap();
        assert!(tls.tls_first);
        assert!(ctx(tls).summary().has_tls);
    }

    #[test]
    fn missing_dir_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let ctxs = load_contexts(Some(dir.path().join("does-not-exist"))).unwrap();
        assert!(ctxs.is_empty());
    }

    #[test]
    fn rejects_unsafe_context_names() {
        for bad in [
            "",
            ".",
            "..",
            "../evil",
            "a/b",
            "a\\b",
            "x..y",
            DEMO_CONTEXT_NAME,
        ] {
            assert!(!valid_context_name(bad), "should reject {bad:?}");
        }
        for good in ["prod-eu", "local_1", "demo.staging", "a.b.c"] {
            assert!(valid_context_name(good), "should accept {good:?}");
        }
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let d = Some(dir.path().to_string_lossy().into_owned());
        save_context(
            d.clone(),
            "prod".into(),
            ContextInput {
                url: "nats://prod:4222".into(),
                token: Some("s3cr3t".into()),
                tls_first: true,
                ..Default::default()
            },
        )
        .unwrap();

        // Written into the CLI-standard context/ subdir, loadable back.
        let ctxs = load_contexts(Some(dir.path().to_path_buf())).unwrap();
        assert_eq!(ctxs.len(), 1);
        assert_eq!(ctxs[0].name, "prod");
        assert_eq!(ctxs[0].file.url, "nats://prod:4222");
        assert_eq!(ctxs[0].file.token.as_deref(), Some("s3cr3t"));
        assert!(ctxs[0].file.tls_first);
        assert_eq!(ctxs[0].summary().auth_method, "token");
    }

    #[test]
    fn save_preserves_unknown_fields_and_clears_stale_auth() {
        let dir = tempfile::tempdir().unwrap();
        let cdir = dir.path().join("context");
        fs::create_dir_all(&cdir).unwrap();
        // Existing file with a token + a field Twigo doesn't model.
        fs::write(
            cdir.join("c.json"),
            r#"{"url":"nats://old:4222","token":"old","color":"red"}"#,
        )
        .unwrap();

        let d = Some(dir.path().to_string_lossy().into_owned());
        save_context(
            d,
            "c".into(),
            ContextInput {
                url: "nats://new:4222".into(),
                user: Some("u".into()),
                password: Some("p".into()),
                ..Default::default()
            },
        )
        .unwrap();

        let raw = fs::read_to_string(cdir.join("c.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["url"], "nats://new:4222");
        assert_eq!(v["user"], "u");
        assert!(v.get("token").is_none(), "stale token cleared");
        assert_eq!(v["color"], "red", "unknown field preserved");
    }

    #[cfg(unix)]
    #[test]
    fn saved_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let d = Some(dir.path().to_string_lossy().into_owned());
        save_context(
            d,
            "p".into(),
            ContextInput {
                url: "nats://p:4222".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let mode = fs::metadata(dir.path().join("context").join("p.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn delete_removes_file_and_clears_selection() {
        let dir = tempfile::tempdir().unwrap();
        let cdir = dir.path().join("context");
        fs::create_dir_all(&cdir).unwrap();
        fs::write(cdir.join("gone.json"), r#"{"url":"nats://x:4222"}"#).unwrap();
        fs::write(dir.path().join("context.txt"), "gone\n").unwrap();

        let d = Some(dir.path().to_string_lossy().into_owned());
        delete_context(d, "gone".into()).unwrap();

        assert!(!cdir.join("gone.json").exists());
        assert!(
            !dir.path().join("context.txt").exists(),
            "selection cleared when the selected context is deleted"
        );
    }

    #[test]
    fn get_context_returns_editable_detail() {
        let dir = tempfile::tempdir().unwrap();
        let d = Some(dir.path().to_string_lossy().into_owned());
        save_context(
            d.clone(),
            "edit-me".into(),
            ContextInput {
                url: "nats://e:4222".into(),
                user: Some("u".into()),
                password: Some("p".into()),
                tls_first: true,
                ..Default::default()
            },
        )
        .unwrap();

        let detail = get_context(d.clone(), "edit-me".into()).unwrap();
        assert_eq!(detail.url, "nats://e:4222");
        assert_eq!(detail.user.as_deref(), Some("u"));
        assert_eq!(detail.password.as_deref(), Some("p"));
        assert!(detail.tls_first);
        assert!(detail.token.is_none());

        assert!(get_context(d, "missing".into()).is_err());
    }

    #[test]
    fn save_rejects_unsafe_name() {
        let dir = tempfile::tempdir().unwrap();
        let d = Some(dir.path().to_string_lossy().into_owned());
        let err = save_context(
            d,
            "../escape".into(),
            ContextInput {
                url: "nats://x:4222".into(),
                ..Default::default()
            },
        );
        assert!(err.is_err());
    }
}
