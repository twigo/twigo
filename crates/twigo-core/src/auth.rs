//! How each context gets its credentials, for the webview: its exec plugin,
//! whether the person trusts it and how its runs go, followed as they change.

use std::sync::Arc;

use tokio::sync::watch;
use twigo_ipc::{
    ContextAuth, EnvVar, ExecPlugin, ExecReview, IpcError, PluginStatus, ReviewedPlugin,
};
use twigo_kube::credentials::{Exec, RunError, Source, Status};

use crate::Core;
use crate::catalog::Contexts;
use crate::trust::Trusted;

impl Core {
    pub fn follow_auth(self: &Arc<Self>, context: String) -> AuthFollower {
        AuthFollower {
            contexts: self.catalog.subscribe(),
            trust: self.trust.subscribe(),
            core: Arc::clone(self),
            context,
            status: None,
            plugin: None,
            last: None,
        }
    }

    /// The plugins the person has not trusted, with the contexts that use
    /// each, once the catalog has been read.
    pub async fn review(&self) -> ExecReview {
        let contexts = self.catalog.contexts().await;
        let trusted = self.trust.current();
        let mut plugins: Vec<ReviewedPlugin> = Vec::new();
        for context in contexts.iter() {
            let Ok(Some(exec)) = context.entries.exec() else {
                continue;
            };
            let digest = exec.trust_digest();
            if trusted.trusts(&digest) {
                continue;
            }
            match plugins.iter_mut().find(|p| p.plugin.digest == digest) {
                Some(reviewed) => reviewed.contexts.push(context.name.clone()),
                None => plugins.push(ReviewedPlugin {
                    plugin: plugin(&exec),
                    contexts: vec![context.name.clone()],
                }),
            }
        }
        ExecReview {
            reviewed: trusted.reviewed,
            plugins,
        }
    }

    pub fn trust_plugins(&self, digests: Vec<String>) -> Result<(), IpcError> {
        self.trust.trust(digests).map_err(|error| IpcError {
            kind: twigo_ipc::ErrorKind::Internal,
            message: format!("could not save the trusted plugins: {error}"),
        })
    }
}

pub struct AuthFollower {
    core: Arc<Core>,
    context: String,
    contexts: watch::Receiver<Option<Arc<Contexts>>>,
    trust: watch::Receiver<Trusted>,
    /// The trusted plugin's, which the follower keeps alive with it.
    status: Option<watch::Receiver<Status>>,
    plugin: Option<Arc<Source>>,
    last: Option<ContextAuth>,
}

impl AuthFollower {
    /// The context's credentials at first, then each time they change.
    pub async fn next(&mut self) -> ContextAuth {
        loop {
            if self.last.is_some() {
                self.changed().await;
            }
            let auth = self.read().await;
            if self.last.as_ref() != Some(&auth) {
                self.last = Some(auth.clone());
                return auth;
            }
        }
    }

    async fn changed(&mut self) {
        let status = async {
            match self.status.as_mut() {
                Some(status) => status.changed().await,
                None => std::future::pending().await,
            }
        };
        let ended = tokio::select! {
            changed = self.contexts.changed() => changed.is_err(),
            changed = self.trust.changed() => changed.is_err(),
            changed = status => changed.is_err(),
        };
        if ended {
            std::future::pending::<()>().await;
        }
    }

    async fn read(&mut self) -> ContextAuth {
        let contexts = self
            .contexts
            .wait_for(Option::is_some)
            .await
            .expect("the catalog outlives its followers")
            .clone()
            .expect("waited for");
        let trusted = self.trust.borrow_and_update().clone();
        // The source stays held until its successor is, so the registry
        // hands out the same one with its credential and its held failure.
        let held = self.plugin.take();
        self.status = None;
        let Some(context) = contexts.find(&self.context) else {
            return ContextAuth::Invalid {
                message: format!("no source lists the context {:?}", self.context),
            };
        };
        let exec = match context.entries.exec() {
            Ok(Some(exec)) => exec,
            Ok(None) => return ContextAuth::None,
            Err(error) => {
                return ContextAuth::Invalid {
                    message: error.to_string(),
                };
            }
        };
        if !trusted.trusts(&exec.trust_digest()) {
            return ContextAuth::Untrusted {
                plugin: plugin(&exec),
            };
        }
        let source = self.core.credentials.source(exec.clone());
        drop(held);
        let mut status = source.status();
        let current = status.borrow_and_update().clone();
        let mut described = plugin(&exec);
        described.signs_in = source.signs_in();
        self.status = Some(status);
        self.plugin = Some(source);
        ContextAuth::Plugin {
            plugin: described,
            status: plugin_status(&current, &exec),
        }
    }
}

fn plugin(exec: &Exec) -> ExecPlugin {
    ExecPlugin {
        command: exec.command().to_owned(),
        args: exec.args().to_vec(),
        env: exec
            .env()
            .iter()
            .map(|(name, value)| EnvVar {
                name: name.clone(),
                value: value.clone(),
            })
            .collect(),
        digest: exec.trust_digest(),
        signs_in: exec.sign_in(),
    }
}

fn plugin_status(status: &Status, exec: &Exec) -> PluginStatus {
    match status {
        Status::Idle => PluginStatus::Idle,
        Status::Waiting => PluginStatus::Waiting,
        Status::Running { since, output } => PluginStatus::Running {
            since: since.to_string(),
            output: output.clone(),
        },
        Status::Ready { expires } => PluginStatus::Ready {
            expires: expires.map(|at| at.to_string()),
        },
        Status::Failed { error, output } => PluginStatus::Failed {
            error: error.to_string(),
            output: output.clone(),
            install_hint: matches!(error, RunError::NotFound(_))
                .then(|| exec.install_hint().filter(|_| exec.on_path()))
                .flatten()
                .map(str::to_owned),
        },
    }
}
