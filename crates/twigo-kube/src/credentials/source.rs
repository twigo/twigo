//! A plugin's credential: cached until shortly before it expires, fetched by
//! one run however many ask at once, and its status for the UI.
//!
//! A plugin that may ask the person to sign in runs only while Twigo's
//! window has the focus, so that a browser it opens or a code it prints
//! finds them, and after a run that failed or was cancelled only when they
//! ask again: retrying by itself would open browser after browser.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use jiff::Timestamp;
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use tokio::sync::{oneshot, watch};
use twigo_env::ShellEnv;

use std::path::PathBuf;

use super::exec::{Exec, Mode};
use super::oidc::{Oidc, OidcEntry};
use super::output::Credential;
use super::run::{self, RunError};

/// How much of a plugin's stderr its status keeps, from its start and from
/// its end: device codes and URLs come first, errors last.
const OUTPUT_HEAD: usize = 8 << 10;
const OUTPUT_TAIL: usize = 8 << 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timeouts {
    /// A plugin that never asks anyone (ARCHITECTURE 6.2).
    pub unattended: Duration,
    /// One the person signs in with, which they can cancel: past the
    /// plugins' own limits, such as int128/kubelogin's and tsh's 180 s, so
    /// that they end their own logins, since a tsh killed mid-login leaves
    /// a lock that breaks the cluster until `tsh login`.
    pub sign_in: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            unattended: Duration::from_secs(120),
            sign_in: Duration::from_secs(10 * 60),
        }
    }
}

/// The sources of every context, so that contexts whose entries name the
/// same plugin share it.
pub struct Registry {
    sources: Mutex<HashMap<String, Weak<Source>>>,
    oidc: Mutex<HashMap<String, Weak<Oidc>>>,
    shared: Shared,
}

#[derive(Clone)]
struct Shared {
    /// The login shell's environment, None until it is known; a run waits
    /// for it.
    env: watch::Receiver<Option<Arc<ShellEnv>>>,
    /// Whether a Twigo window has the focus.
    focused: watch::Receiver<bool>,
    timeouts: Timeouts,
}

impl Registry {
    pub fn new(
        env: watch::Receiver<Option<Arc<ShellEnv>>>,
        focused: watch::Receiver<bool>,
        timeouts: Timeouts,
    ) -> Self {
        Self {
            sources: Mutex::default(),
            oidc: Mutex::default(),
            shared: Shared {
                env,
                focused,
                timeouts,
            },
        }
    }

    /// Kills every plugin under way, as the app quits: one waiting for a
    /// browser would keep its port, and the next run could not listen.
    pub fn shutdown(&self) {
        let sources = self.sources.lock().expect("registry lock");
        for source in sources.values().filter_map(Weak::upgrade) {
            source.kill();
        }
    }

    pub fn source(&self, exec: Exec) -> Arc<Source> {
        let key = exec.key();
        let mut sources = self.sources.lock().expect("registry lock");
        if let Some(source) = sources.get(&key).and_then(Weak::upgrade) {
            return source;
        }
        sources.retain(|_, source| source.strong_count() > 0);
        let source = Arc::new(Source::new(exec, self.shared.clone()));
        sources.insert(key, Arc::downgrade(&source));
        source
    }

    /// The `auth-provider: oidc` of `user`, from its file of origin
    /// `origin`, which its refreshed tokens go back to.
    pub fn oidc(&self, origin: Option<PathBuf>, user: &str, entry: OidcEntry) -> Arc<Oidc> {
        let key = entry.key(origin.as_deref(), user);
        let mut sources = self.oidc.lock().expect("registry lock");
        if let Some(source) = sources.get(&key).and_then(Weak::upgrade) {
            return source;
        }
        sources.retain(|_, source| source.strong_count() > 0);
        let source = Arc::new(Oidc::new(
            origin,
            user.to_owned(),
            entry,
            self.shared.env.clone(),
        ));
        sources.insert(key, Arc::downgrade(&source));
        source
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    /// No credential, and none asked for since Twigo started or since the
    /// server rejected the last one.
    Idle,
    /// A plugin that may ask the person to sign in waits for Twigo's window
    /// to have the focus.
    Waiting,
    /// What it printed on stderr so far.
    Running {
        since: Timestamp,
        output: String,
    },
    Ready {
        expires: Option<Timestamp>,
    },
    /// For a plugin that may ask the person to sign in, it stays so until
    /// they sign in again.
    Failed {
        error: RunError,
        output: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CredentialError {
    /// A sign-in failed or was cancelled, so the plugin waits for the
    /// person to sign in again.
    #[error("sign in again: {0}")]
    SignInFailed(RunError),
    #[error(transparent)]
    Run(#[from] RunError),
}

pub struct Source {
    exec: Exec,
    shared: Shared,
    state: Mutex<State>,
    status: watch::Sender<Status>,
}

#[derive(Default)]
struct State {
    credential: Option<Arc<Credential>>,
    run: Option<Run>,
    /// Why the last sign-in failed, until the person signs in again.
    held: Option<RunError>,
}

type Outcome = Option<Result<Arc<Credential>, RunError>>;

struct Run {
    done: watch::Receiver<Outcome>,
    cancel: Option<oneshot::Sender<()>>,
    /// The plugin's process group, once it started.
    group: Option<Pid>,
}

impl std::fmt::Debug for Source {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Source")
            .field("command", &self.exec.command())
            .finish_non_exhaustive()
    }
}

impl Source {
    fn new(exec: Exec, shared: Shared) -> Self {
        Self {
            exec,
            shared,
            state: Mutex::default(),
            status: watch::Sender::new(Status::Idle),
        }
    }

    pub fn exec(&self) -> &Exec {
        &self.exec
    }

    pub fn status(&self) -> watch::Receiver<Status> {
        self.status.subscribe()
    }

    /// The cached credential, else the one the run under way or a new run
    /// gets.
    pub async fn credential(self: &Arc<Self>) -> Result<Arc<Credential>, CredentialError> {
        let mut focused = self.shared.focused.clone();
        loop {
            let done = {
                let mut state = self.state();
                if let Some(credential) = state
                    .credential
                    .as_ref()
                    .filter(|credential| credential.valid_at(Timestamp::now()))
                {
                    return Ok(Arc::clone(credential));
                }
                match &state.run {
                    Some(run) => Some(run.done.clone()),
                    None if self.signs_in() => {
                        if let Some(error) = &state.held {
                            return Err(CredentialError::SignInFailed(error.clone()));
                        }
                        if *focused.borrow_and_update() {
                            Some(self.start(&mut state))
                        } else {
                            self.status.send_replace(Status::Waiting);
                            None
                        }
                    }
                    None => Some(self.start(&mut state)),
                }
            };
            match done {
                Some(done) => return Ok(outcome(done).await?),
                None => {
                    if focused.changed().await.is_err() {
                        std::future::pending::<()>().await;
                    }
                }
            }
        }
    }

    /// Runs the plugin now, unless a run is under way: how the person signs
    /// in, again after a failure too.
    pub fn sign_in(self: &Arc<Self>) {
        let mut state = self.state();
        state.held = None;
        if state.run.is_none() {
            self.start(&mut state);
        }
    }

    /// Whether the plugin may ask the person to sign in, with the login
    /// shell's environment, which Azure/kubelogin reads its login method
    /// from too; as the entry alone says until that environment is known.
    pub fn signs_in(&self) -> bool {
        match &*self.shared.env.borrow() {
            Some(env) => self.exec.signs_in_with(env),
            None => self.exec.sign_in(),
        }
    }

    fn kill(&self) {
        let group = self.state().run.as_ref().and_then(|run| run.group);
        if let Some(group) = group {
            // It may have just ended.
            let _ = killpg(group, Signal::SIGKILL);
        }
    }

    /// Ends the run under way.
    pub fn cancel(&self) {
        let cancel = self.state().run.as_mut().and_then(|run| run.cancel.take());
        if let Some(cancel) = cancel {
            // The run may have just ended.
            let _ = cancel.send(());
        }
    }

    /// Drops `used`, which the server rejected, unless another credential
    /// already replaced it.
    pub(crate) fn reject(&self, used: &Arc<Credential>) {
        let mut state = self.state();
        if state
            .credential
            .as_ref()
            .is_some_and(|cached| Arc::ptr_eq(cached, used))
        {
            state.credential = None;
            self.status.send_replace(Status::Idle);
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("source lock")
    }

    fn start(self: &Arc<Self>, state: &mut State) -> watch::Receiver<Outcome> {
        let (done, outcome) = watch::channel(None);
        let (cancel, cancelled) = oneshot::channel();
        state.run = Some(Run {
            done: outcome.clone(),
            cancel: Some(cancel),
            group: None,
        });
        self.status.send_replace(Status::Running {
            since: Timestamp::now(),
            output: String::new(),
        });
        let source = Arc::clone(self);
        tokio::spawn(async move {
            let result = source.run(cancelled).await.map(Arc::new);
            let mut state = source.state();
            state.run = None;
            match &result {
                Ok(credential) => {
                    state.credential = Some(Arc::clone(credential));
                    source.status.send_replace(Status::Ready {
                        expires: credential.expires(),
                    });
                }
                Err(error) => {
                    if source.signs_in() {
                        state.held = Some(error.clone());
                    }
                    source.status.send_modify(|status| {
                        let output = match status {
                            Status::Running { output, .. } => std::mem::take(output),
                            _ => String::new(),
                        };
                        *status = Status::Failed {
                            error: error.clone(),
                            output,
                        };
                    });
                }
            }
            drop(state);
            done.send_replace(Some(result));
        });
        outcome
    }

    async fn run(&self, cancelled: oneshot::Receiver<()>) -> Result<Credential, RunError> {
        if self.exec.mode() == Mode::Always {
            return Err(RunError::NeedsTerminal);
        }
        let env = Arc::clone(
            self.shared
                .env
                .clone()
                .wait_for(Option::is_some)
                .await
                .expect("the environment outlives its sources")
                .as_ref()
                .expect("waited for"),
        );
        let cancel = async {
            // Dropped unsent only when the run is over.
            if cancelled.await.is_err() {
                std::future::pending::<()>().await;
            }
        };
        let timeout = if self.signs_in() {
            self.shared.timeouts.sign_in
        } else {
            self.shared.timeouts.unattended
        };
        let started = |group| {
            if let Some(run) = self.state().run.as_mut() {
                run.group = Some(group);
            }
        };
        // Raw, so a character split between two reads comes out whole.
        let mut head = Vec::new();
        let mut tail = Vec::new();
        let mut cut = false;
        run::run(&self.exec, &env, timeout, cancel, started, |mut chunk| {
            let taken = OUTPUT_HEAD.saturating_sub(head.len()).min(chunk.len());
            head.extend_from_slice(&chunk[..taken]);
            chunk = &chunk[taken..];
            tail.extend_from_slice(chunk);
            if tail.len() > OUTPUT_TAIL {
                tail.drain(..tail.len() - OUTPUT_TAIL);
                cut = true;
            }
            let mut output = String::from_utf8_lossy(&head).into_owned();
            if cut {
                output.push_str("\n…\n");
            }
            output.push_str(&String::from_utf8_lossy(&tail));
            self.status.send_modify(|status| {
                if let Status::Running { output: shown, .. } = status {
                    *shown = output;
                }
            });
        })
        .await
    }
}

async fn outcome(mut done: watch::Receiver<Outcome>) -> Result<Arc<Credential>, RunError> {
    let outcome = done
        .wait_for(Option::is_some)
        .await
        .expect("a run sends its outcome before it ends");
    outcome.clone().expect("waited for")
}
