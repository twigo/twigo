//! Terminals on this machine pinned to a context (ARCHITECTURE 4.6): the
//! login shell on a pty, run over the shell commands beside the shells in
//! pods. How one reaches clusters is decided as it is created: through the
//! policy proxy alone, or with the user's own kubeconfig behind Twigo's file
//! of the context. zsh, bash, fish and pwsh set the terminal's `KUBECONFIG`
//! again after their own startup files. What tools write into its first
//! file is offered for moving into the user's.

mod directory;
mod environment;
mod offers;
#[cfg(test)]
mod tests;
mod watcher;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use futures::future::Either;
use twigo_ipc::{
    AnswerKubeconfigOffer, ErrorKind, IpcError, KubeconfigOffer, KubeconfigOfferAnswer,
    KubeconfigOfferEvent, Mode, NewTerminal, ProxyWhy, ShellEvent, TerminalKind, TerminalSession,
};
use twigo_kube::client::Actor;
use twigo_kube::kubeconfig::{Names, Reach, Sources};
use twigo_policy::Policy;
use twigo_sessions::shell::Frame;
use twigo_sessions::terminal::{Spec, Terminal};

use crate::proxy::ProxyProcess;
use crate::{ClientsError, Core};
use directory::Directory;
pub(crate) use offers::Offers;
use offers::Source;
use watcher::Watcher;

/// A session of the shells' table: a shell in a pod, or a terminal here.
pub(crate) enum Shell {
    Pod(twigo_sessions::shell::Session),
    Local(Local),
}

pub(crate) struct Local {
    // Dropped first: the shell hangs up before its tokens are revoked, and
    // the watch ends before its directory goes.
    session: Terminal,
    _watcher: Option<Watcher>,
    /// A proxy terminal's process, which ends with its shell: a job the
    /// shell left, as `kubectl port-forward … &` before `exit`, loses the
    /// proxy with it.
    proxy: Option<Arc<Mutex<Option<ProxyProcess>>>>,
    /// Its directory, which lives as long as its tab: kubectl in a job the
    /// shell left would take the person's current context without Twigo's
    /// file in it.
    _directory: Directory,
}

impl Shell {
    pub(crate) fn open(
        &self,
        cols: u16,
        rows: u16,
        send: impl FnMut(Frame) -> bool + Send + 'static,
    ) -> Result<(), IpcError> {
        match self {
            Self::Pod(session) => session.open(cols, rows, send),
            Self::Local(local) => {
                let proxy = local.proxy.clone();
                let mut send = send;
                local.session.open(cols, rows, move |frame| {
                    if let (Some(proxy), Frame::Event(ShellEvent::Ended { .. })) = (&proxy, &frame)
                    {
                        drop(proxy.lock().expect("proxy lock").take());
                    }
                    send(frame)
                })
            }
        }
    }

    pub(crate) fn input(&self, data: Vec<u8>) -> impl Future<Output = ()> + Send + use<> {
        match self {
            Self::Pod(session) => Either::Left(session.input(data)),
            Self::Local(local) => Either::Right(local.session.input(data)),
        }
    }

    pub(crate) fn resize(&self, cols: u16, rows: u16) {
        match self {
            Self::Pod(session) => session.resize(cols, rows),
            Self::Local(local) => local.session.resize(cols, rows),
        }
    }

    pub(crate) fn ack(&self, bytes: u32) {
        match self {
            Self::Pod(session) => session.ack(bytes),
            Self::Local(local) => local.session.ack(bytes),
        }
    }

    /// Hangs up a terminal here at once, as the app quits.
    pub(crate) fn quit(&self) {
        if let Self::Local(local) = self {
            local.session.hang_up();
        }
    }
}

/// The core's terminals: their directories and their offers.
pub(crate) struct Terminals {
    /// `terminals/` in the app's data directory.
    root: PathBuf,
    made: AtomicU64,
    offers: Arc<Offers>,
    /// What tests run in place of the login shell.
    program: Mutex<Option<(PathBuf, Vec<OsString>)>>,
    /// Twigo's own `ZDOTDIR`, which a terminal app hands its shell, so zsh
    /// reads the person's `.zshenv` where it would: the login shell's
    /// environment is read after that file ran, which may have moved it.
    zdotdir: Mutex<Option<OsString>>,
}

impl Terminals {
    /// Deletes what a previous run left in `root`.
    pub(crate) fn new(root: PathBuf) -> Self {
        directory::wipe(&root);
        Self {
            root,
            made: AtomicU64::new(0),
            offers: Arc::new(Offers::new()),
            program: Mutex::default(),
            zdotdir: Mutex::new(std::env::var_os("ZDOTDIR")),
        }
    }

    pub(crate) fn drop_window(&self, window: &str) {
        self.offers.drop_window(window);
    }

    /// Makes every offer anew, as the user's files have changed.
    pub(crate) async fn refresh_offers(&self) {
        let offers = Arc::clone(&self.offers);
        tokio::task::spawn_blocking(move || offers.refresh())
            .await
            .expect("a refresh does not panic");
    }
}

/// How a terminal of `context` reaches clusters: through the policy proxy
/// where the admin's policy file says so, or the context is not
/// `read-write`, an unlocked one included; else with the user's own
/// kubeconfig. A later change of mode changes nothing in a terminal, whose
/// proxy follows the mode by itself.
pub(crate) fn kind(policy: &Policy, context: &str) -> TerminalKind {
    if policy.uses_policy_proxy(context) {
        TerminalKind::Proxy {
            why: ProxyWhy::PolicyFile,
        }
    } else if policy.access(context).mode != Mode::ReadWrite {
        TerminalKind::Proxy {
            why: ProxyWhy::Mode,
        }
    } else {
        TerminalKind::Kubeconfig
    }
}

fn written(path: &Path, error: std::io::Error) -> IpcError {
    IpcError::new(
        ErrorKind::Internal,
        format!("could not write {}: {error}", path.display()),
    )
}

impl Core {
    /// Parks a terminal of `request.context` for `window`, which starts once
    /// `shell_open` names it. Async, as a proxy terminal's endpoint serves
    /// on the runtime, and its watch waits for the login shell's
    /// environment.
    pub async fn terminal_create(
        &self,
        window: &str,
        request: NewTerminal,
    ) -> Result<TerminalSession, IpcError> {
        let ticket = self.shells.ticket(window);
        let NewTerminal { context, label } = request;
        let login = self
            .shell_env
            .subscribe()
            .wait_for(Option::is_some)
            .await
            .expect("the core outlives its subscribers")
            .clone()
            .expect("waited for");
        // After the wait, which can take seconds at startup, with none
        // before a kubeconfig terminal parks; a proxy terminal waits for its
        // process, whose proxy follows the mode by itself.
        let contexts = self.catalog.contexts().await;
        let Some(found) = contexts.find(&context) else {
            return Err(IpcError::from(&ClientsError::NoContext(context)));
        };
        let kind = kind(&self.policy, &context);
        let sources = self
            .catalog
            .sources()
            .expect("the catalog follows its sources before it lists");
        let seam = self.terminals.program.lock().expect("program lock").clone();
        let (program, args) = seam.unwrap_or_else(|| {
            let shell = twigo_env::login_shell();
            let args = twigo_env::terminal_args(&shell)
                .iter()
                .map(OsString::from)
                .collect();
            (shell, args)
        });
        let made = self.terminals.made.fetch_add(1, Ordering::Relaxed);
        let root = &self.terminals.root;
        let directory = Directory::create(root, made).map_err(|e| written(root, e))?;
        let (proxy, file, kubeconfig) = match kind {
            TerminalKind::Proxy { .. } => {
                let process = self
                    .proxy_process(Actor::Terminal, &label, Some(window), &context)
                    .await?;
                let file = process.kubeconfig().to_owned();
                let kubeconfig = file.clone().into_os_string();
                (Some(Arc::new(Mutex::new(Some(process)))), file, kubeconfig)
            }
            TerminalKind::Kubeconfig => {
                let entry = &found.entries.kubeconfig().contexts[0];
                let file = directory.kubeconfig(entry).map_err(|e| written(root, e))?;
                let kubeconfig = std::env::join_paths(
                    std::iter::once(file.as_path())
                        .chain(sources.files().iter().map(PathBuf::as_path)),
                )
                .map_err(|error| {
                    IpcError::new(
                        ErrorKind::InvalidInput,
                        format!("a kubeconfig file's path cannot join KUBECONFIG: {error}"),
                    )
                })?;
                (None, file, kubeconfig)
            }
        };
        let zdotdir = self.terminals.zdotdir.lock().expect("zdotdir lock").clone();
        let startup = twigo_env::Startup::of(
            &program,
            &args,
            &kubeconfig,
            directory.path(),
            zdotdir.as_deref(),
        );
        let kubeconfig_kept = startup.is_some();
        let (args, startup_env) = match startup {
            Some(startup) => {
                for (name, contents) in &startup.files {
                    let path = directory.path();
                    directory
                        .write(name, contents)
                        .map_err(|e| written(path, e))?;
                }
                (startup.args, startup.env)
            }
            None => (args, Vec::new()),
        };
        let chained = kind == TerminalKind::Kubeconfig;
        let (watcher, source) = self
            .watch_offers(window, &label, &context, &file, sources, chained)
            .unzip();
        let env =
            environment::environment(&login, &kubeconfig, &startup_env, twigo_env::utf8_locale);
        let cwd = login
            .get("HOME")
            .map_or_else(|| PathBuf::from("/"), PathBuf::from);
        let shell = program
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let session = Terminal::park(Spec {
            program,
            args,
            env,
            cwd,
        });
        let local = Local {
            session,
            _watcher: watcher,
            proxy,
            _directory: directory,
        };
        let id = self.shells.keep(ticket, Shell::Local(local))?;
        if let Some(source) = source {
            source.session.set(id).expect("set once");
        }
        Ok(TerminalSession {
            id,
            kind,
            shell,
            kubeconfig_kept,
        })
    }

    /// Follows `file` for offers of `window`'s terminal, while the user's
    /// files give kubectl somewhere to write new entries: the watch, and
    /// the source it offers from, whose session the caller sets. The user's
    /// files follow `file` in its `KUBECONFIG` where it is `chained`.
    fn watch_offers(
        &self,
        window: &str,
        label: &str,
        context: &str,
        file: &Path,
        sources: Sources,
        chained: bool,
    ) -> Option<(Watcher, Arc<Source>)> {
        let target = sources.target()?.to_owned();
        let text = match std::fs::read_to_string(file) {
            Ok(text) => text,
            Err(error) => {
                eprintln!("could not read {}: {error}", file.display());
                return None;
            }
        };
        let parses = "Twigo writes a kubeconfig that parses";
        let written = Names::of(&text).expect(parses);
        let proxied = (!chained).then(|| Reach::of(&text).expect(parses));
        let source = Arc::new(Source {
            window: window.into(),
            label: label.into(),
            context: context.to_owned(),
            session: OnceLock::new(),
            file: file.to_owned(),
            sources,
            target,
            chained,
            stopped: AtomicBool::new(false),
        });
        let offers = Arc::clone(&self.terminals.offers);
        match watcher::watch(offers, Arc::clone(&source), written, proxied) {
            Ok(watcher) => Some((watcher, source)),
            Err(error) => {
                eprintln!(
                    "could not watch {}, so what tools write there is not offered: {error}",
                    file.display()
                );
                None
            }
        }
    }

    /// The offers of `window`'s terminals waiting now; `send` gets the
    /// contexts each of its proxy terminals reaches past the proxy, where
    /// there are any, then each new, changed and withdrawn offer and each
    /// change of those contexts, in place of what the window followed
    /// before. It must not call back into the core.
    pub fn follow_kubeconfig_offers(
        &self,
        window: &str,
        send: impl FnMut(KubeconfigOfferEvent) -> bool + Send + 'static,
    ) -> Vec<KubeconfigOffer> {
        self.terminals.offers.follow(window, send)
    }

    /// Moves an offer's entries into the user's kubeconfig, or dismisses
    /// it, which withdraws it; refused for one that is gone, another
    /// window's, or of another revision than the one answered, which then
    /// changes nothing. A move that fails leaves the offer waiting, and one that
    /// would leave out more than the offer said moves nothing and makes the
    /// offer anew, refused as a conflict. Async, as the move waits for
    /// kubectl's lock.
    pub async fn answer_kubeconfig_offer(
        &self,
        window: &str,
        answer: AnswerKubeconfigOffer,
    ) -> Result<(), IpcError> {
        let offers = &self.terminals.offers;
        let answering = offers.take(window, answer)?;
        if answer.answer == KubeconfigOfferAnswer::Dismiss {
            offers.withdraw(answering);
            return Ok(());
        }
        let (moved, answering) =
            tokio::task::spawn_blocking(move || (answering.move_entries(), answering))
                .await
                .expect("a move does not panic");
        offers.moved(answering, moved)
    }

    /// Runs `program` with `args` in every terminal made from now on, in
    /// place of the login shell.
    #[cfg(feature = "test-util")]
    pub fn set_terminal_program(&self, program: PathBuf, args: Vec<OsString>) {
        *self.terminals.program.lock().expect("program lock") = Some((program, args));
    }

    /// Takes `zdotdir` for Twigo's own `ZDOTDIR` in every terminal made from
    /// now on, so no test reads the startup files of whoever runs it.
    #[cfg(feature = "test-util")]
    pub fn set_terminal_zdotdir(&self, zdotdir: Option<OsString>) {
        *self.terminals.zdotdir.lock().expect("zdotdir lock") = zdotdir;
    }
}
