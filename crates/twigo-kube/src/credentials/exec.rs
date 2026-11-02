//! An exec plugin as a user entry names it, checked as client-go checks it
//! (`tools/clientcmd/validation.go`), and what it runs with.

use std::collections::HashMap;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use kube::config::{AuthInfo, Cluster, ExecInteractiveMode};
use ring::digest::{SHA256, digest};
use secrecy::ExposeSecret;
use serde::Serialize;
use serde_json::{Map, Value, json};

use twigo_env::ShellEnv;

use super::sign_in;

/// The cluster extension client-go hands the plugin as `spec.cluster.config`.
const CLUSTER_EXTENSION: &str = "client.authentication.k8s.io/exec";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ApiVersion {
    #[serde(rename = "client.authentication.k8s.io/v1")]
    V1,
    #[serde(rename = "client.authentication.k8s.io/v1beta1")]
    V1Beta1,
}

impl ApiVersion {
    pub fn as_str(self) -> &'static str {
        match self {
            ApiVersion::V1 => "client.authentication.k8s.io/v1",
            ApiVersion::V1Beta1 => "client.authentication.k8s.io/v1beta1",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Mode {
    Never,
    IfAvailable,
    /// Needs a terminal, which Twigo never has: client-go refuses such a
    /// plugin when its stdin is not one.
    Always,
}

/// An exec plugin and everything its runs depend on, so two contexts whose
/// entries name the same one share its runs and its credential, as they do
/// in client-go, which keys its authenticators by the exec config and the
/// cluster info it passes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Exec {
    command: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    api_version: ApiVersion,
    mode: Mode,
    install_hint: Option<String>,
    /// `spec.cluster` of `KUBERNETES_EXEC_INFO`, when the entry sets
    /// `provideClusterInfo`.
    cluster: Option<Value>,
    sign_in: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ExecError {
    #[error("command must be specified for {0} to use exec authentication plugin")]
    MissingCommand(String),
    #[error("apiVersion must be specified for {0} to use exec authentication plugin")]
    MissingApiVersion(String),
    #[error("exec plugin: invalid apiVersion {0:?}")]
    InvalidApiVersion(String),
    #[error("interactiveMode must be specified for {0} to use exec authentication plugin")]
    MissingMode(String),
    #[error("an env entry of the exec plugin of {0} has no name")]
    UnnamedEnv(String),
    #[error("authProvider cannot be provided in combination with an exec plugin for {0}")]
    WithAuthProvider(String),
    #[error("failed to load CA bundle for execProvider: {0}")]
    CertificateAuthority(String),
}

impl Exec {
    /// The plugin of the user entry `user`, unless the entry has none or
    /// names a token, basic auth or a client certificate, which client-go
    /// uses instead (`plugin/pkg/client/auth/exec/exec.go`, `UpdateTransportConfig`).
    pub fn of(name: &str, user: &AuthInfo, cluster: &Cluster) -> Result<Option<Self>, ExecError> {
        let Some(exec) = &user.exec else {
            return Ok(None);
        };
        if user.auth_provider.is_some() {
            return Err(ExecError::WithAuthProvider(name.to_owned()));
        }
        let set = |value: Option<&str>| value.is_some_and(|value| !value.is_empty());
        let has_cert = (set(user.client_certificate.as_deref())
            || set(user.client_certificate_data.as_deref()))
            && (set(user.client_key.as_deref())
                || user
                    .client_key_data
                    .as_ref()
                    .is_some_and(|key| !key.expose_secret().is_empty()));
        if token_or_basic(user) || has_cert {
            return Ok(None);
        }
        let command = exec
            .command
            .clone()
            .filter(|command| !command.is_empty())
            .ok_or_else(|| ExecError::MissingCommand(name.to_owned()))?;
        let api_version = match exec.api_version.as_deref() {
            None | Some("") => return Err(ExecError::MissingApiVersion(name.to_owned())),
            Some("client.authentication.k8s.io/v1") => ApiVersion::V1,
            Some("client.authentication.k8s.io/v1beta1") => ApiVersion::V1Beta1,
            Some(other) => return Err(ExecError::InvalidApiVersion(other.to_owned())),
        };
        // v1beta1 defaults the mode, v1 requires it
        // (`tools/clientcmd/api/v1beta1/defaults.go`, `api/v1/defaults.go`).
        let mode = match (&exec.interactive_mode, api_version) {
            (Some(ExecInteractiveMode::Never), _) => Mode::Never,
            (Some(ExecInteractiveMode::IfAvailable), _) | (None, ApiVersion::V1Beta1) => {
                Mode::IfAvailable
            }
            (Some(ExecInteractiveMode::Always), _) => Mode::Always,
            (None, ApiVersion::V1) => return Err(ExecError::MissingMode(name.to_owned())),
        };
        let env: Vec<_> = exec
            .env
            .iter()
            .flatten()
            .map(|entry| env_entry(name, entry))
            .collect::<Result<_, _>>()?;
        let args = exec.args.clone().unwrap_or_default();
        let cluster = exec
            .provide_cluster_info
            .then(|| cluster_info(cluster))
            .transpose()?;
        Ok(Some(Self {
            sign_in: sign_in::needs(&command, &args, &env),
            command,
            args,
            env,
            api_version,
            mode,
            install_hint: exec.install_hint.clone().filter(|hint| !hint.is_empty()),
            cluster,
        }))
    }

    pub fn command(&self) -> &str {
        &self.command
    }

    pub fn args(&self) -> &[String] {
        &self.args
    }

    pub fn env(&self) -> &[(String, String)] {
        &self.env
    }

    pub fn api_version(&self) -> ApiVersion {
        self.api_version
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn install_hint(&self) -> Option<&str> {
        self.install_hint.as_deref()
    }

    /// Whether the plugin may ask the person to sign in, so that it runs
    /// only while Twigo's window has the focus.
    pub fn sign_in(&self) -> bool {
        self.sign_in
    }

    /// [`Exec::sign_in`], with the login shell's environment under the
    /// entry's, as the plugin gets them.
    pub fn signs_in_with(&self, shell: &ShellEnv) -> bool {
        let mut env: Vec<(String, String)> = shell
            .iter()
            .filter_map(|(name, value)| {
                Some((name.to_str()?.to_owned(), value.to_str()?.to_owned()))
            })
            .collect();
        env.extend(self.env.iter().cloned());
        sign_in::needs(&self.command, &self.args, &env)
    }

    /// Whether the command is looked up on `PATH`: a name with no path
    /// separator, as Go's `exec.Command` reads it.
    pub fn on_path(&self) -> bool {
        Path::new(&self.command).file_name() == Some(self.command.as_ref())
    }

    /// Identifies what the person trusts: the command, its arguments and its
    /// environment (ARCHITECTURE 6.2). Kept on disk, so it hashes alike in
    /// every build.
    pub fn trust_digest(&self) -> String {
        hex(&json!([self.command, self.args, self.env]))
    }

    /// Identifies the plugin's runs and credential.
    pub(super) fn key(&self) -> String {
        hex(&serde_json::to_value(self).expect("an exec config serializes to JSON"))
    }

    /// `KUBERNETES_EXEC_INFO`: Twigo never passes a terminal, so the plugin
    /// is never interactive.
    pub(super) fn info(&self) -> String {
        let mut spec = Map::new();
        if let Some(cluster) = &self.cluster {
            spec.insert("cluster".to_owned(), cluster.clone());
        }
        spec.insert("interactive".to_owned(), Value::Bool(false));
        json!({
            "kind": "ExecCredential",
            "apiVersion": self.api_version.as_str(),
            "spec": spec,
        })
        .to_string()
    }
}

/// Whether the entry names a token or basic auth, which win over a plugin
/// or a provider, set as client-go reads them: not empty.
pub(crate) fn token_or_basic(user: &AuthInfo) -> bool {
    let set = |value: Option<&str>| value.is_some_and(|value| !value.is_empty());
    user.token
        .as_ref()
        .is_some_and(|token| !token.expose_secret().is_empty())
        || set(user.token_file.as_deref())
        || set(user.username.as_deref())
}

fn env_entry(user: &str, entry: &HashMap<String, String>) -> Result<(String, String), ExecError> {
    let name = entry
        .get("name")
        .filter(|name| !name.is_empty())
        .ok_or_else(|| ExecError::UnnamedEnv(user.to_owned()))?;
    let value = entry.get("value").cloned().unwrap_or_default();
    Ok((name.clone(), value))
}

/// client-go's `ConfigToExecCluster` (`rest/exec.go`): the CA as the bytes
/// of its file or data, and the cluster extension as `config`.
fn cluster_info(cluster: &Cluster) -> Result<Value, ExecError> {
    let ca = match (
        &cluster.certificate_authority_data,
        &cluster.certificate_authority,
    ) {
        (Some(data), _) => Some(
            STANDARD
                .decode(data.trim())
                .map_err(|error| ExecError::CertificateAuthority(error.to_string()))?,
        ),
        (None, Some(file)) => Some(
            std::fs::read(file)
                .map_err(|error| ExecError::CertificateAuthority(error.to_string()))?,
        ),
        (None, None) => None,
    };
    let mut info = Map::new();
    info.insert(
        "server".to_owned(),
        Value::String(cluster.server.clone().unwrap_or_default()),
    );
    let mut set = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            info.insert(key.to_owned(), value);
        }
    };
    set(
        "tls-server-name",
        cluster.tls_server_name.clone().map(Value::String),
    );
    set(
        "insecure-skip-tls-verify",
        cluster
            .insecure_skip_tls_verify
            .filter(|&on| on)
            .map(Value::Bool),
    );
    set(
        "certificate-authority-data",
        ca.map(|bytes| Value::String(STANDARD.encode(bytes))),
    );
    set("proxy-url", cluster.proxy_url.clone().map(Value::String));
    set(
        "disable-compression",
        cluster
            .disable_compression
            .filter(|&on| on)
            .map(Value::Bool),
    );
    set(
        "config",
        cluster
            .extensions
            .iter()
            .flatten()
            .find(|extension| extension.name == CLUSTER_EXTENSION)
            .map(|extension| extension.extension.clone()),
    );
    Ok(Value::Object(info))
}

fn hex(value: &Value) -> String {
    digest(&SHA256, value.to_string().as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
