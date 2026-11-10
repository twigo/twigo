//! A process's kubeconfig (ARCHITECTURE 6.4): one context per context the
//! catalog lists, named as the catalog names it, whose server is the proxy's
//! path for it, trusted by the proxy's CA, and whose user holds only its
//! token. No `proxy-url`: Go never proxies a loopback address
//! ([`useProxy`]).
//!
//! [`useProxy`]: https://github.com/golang/go/blob/go1.27.1/src/vendor/golang.org/x/net/http/httpproxy/proxy.go#L170-L188

use std::io::Write;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use serde_json::{Value, json};
use twigo_kube::kubeconfig::Context;

use super::tokens::Token;

pub(super) struct Entry {
    pub name: String,
    pub server: String,
    /// The catalog context's own, so kubectl lists where it would.
    pub namespace: Option<String>,
    pub token: Token,
}

/// The namespace a catalog context names.
pub(super) fn namespace(context: &Context) -> Option<String> {
    let config = context.entries.kubeconfig();
    config.contexts.first()?.context.as_ref()?.namespace.clone()
}

/// Writes the file at `path` in `dir`, which only the user may enter, the
/// file only the user may read, before anything gives out its path. JSON,
/// which kubectl reads as YAML.
pub(super) fn write(
    dir: &Path,
    path: &Path,
    entries: &[Entry],
    current: &str,
    ca: &str,
) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};
        builder.mode(0o700);
        builder.create(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    builder.create(dir)?;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    let config = config(entries, current, ca);
    file.write_all(&serde_json::to_vec_pretty(&config).expect("JSON"))?;
    file.sync_all()
}

fn config(entries: &[Entry], current: &str, ca: &str) -> Value {
    let ca = STANDARD.encode(ca);
    let clusters: Vec<Value> = entries
        .iter()
        .map(|entry| {
            let cluster = json!({ "server": entry.server, "certificate-authority-data": ca });
            json!({ "name": entry.name, "cluster": cluster })
        })
        .collect();
    let users: Vec<Value> = entries
        .iter()
        .map(|entry| json!({ "name": entry.name, "user": { "token": entry.token.as_str() } }))
        .collect();
    let contexts: Vec<Value> = entries
        .iter()
        .map(|entry| {
            let mut context = json!({ "cluster": entry.name, "user": entry.name });
            if let Some(namespace) = &entry.namespace {
                context["namespace"] = json!(namespace);
            }
            json!({ "name": entry.name, "context": context })
        })
        .collect();
    json!({
        "apiVersion": "v1",
        "kind": "Config",
        "clusters": clusters,
        "users": users,
        "contexts": contexts,
        "current-context": current,
    })
}
