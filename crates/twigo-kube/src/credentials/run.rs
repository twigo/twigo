//! One run of a plugin: in its own process group, without input, its
//! output capped, its stderr handed on as it comes, and its group killed on
//! a timeout or a cancel.

use std::future::Future;
use std::io;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use twigo_env::ShellEnv;

use super::exec::Exec;
use super::output::{self, Credential, OutputError};

/// An `ExecCredential` is a few KiB; past this a plugin is printing without
/// end.
const MAX_STDOUT: u64 = 1 << 20;

/// How long stderr may stay open once the plugin exited: a helper it left
/// running may hold it, and client-go never waits for it.
const STDERR_GRACE: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RunError {
    #[error("exec: executable {0} not found")]
    NotFound(String),
    #[error("exec: could not run {command}: {message}")]
    Start { command: String, message: String },
    #[error("exec: executable {command} failed with {status}")]
    Exit { command: String, status: String },
    #[error("exec: executable {command} did not answer in {} s", .after.as_secs())]
    Timeout { command: String, after: Duration },
    #[error("exec: {0} was cancelled")]
    Cancelled(String),
    #[error("exec: executable {0} printed more than 1 MiB")]
    TooMuchOutput(String),
    #[error("exec: could not read the output of {command}: {message}")]
    Read { command: String, message: String },
    #[error(transparent)]
    Output(#[from] OutputError),
    #[error("exec plugin cannot support interactive mode: standard input is not a terminal")]
    NeedsTerminal,
}

/// Runs `exec` once with `env`, the login shell's environment, tells
/// `started` the process group it runs in, and passes each chunk of its
/// stderr to `stderr`.
pub(super) async fn run(
    exec: &Exec,
    env: &ShellEnv,
    timeout: Duration,
    cancel: impl Future<Output = ()>,
    started: impl FnOnce(Pid),
    mut stderr: impl FnMut(&[u8]),
) -> Result<Credential, RunError> {
    let command = exec.command().to_owned();
    let mut child = spawn(exec, env).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => RunError::NotFound(command.clone()),
        _ => RunError::Start {
            command: command.clone(),
            message: error.to_string(),
        },
    })?;
    let group = child
        .id()
        .and_then(|id| i32::try_from(id).ok())
        .map(Pid::from_raw);
    if let Some(group) = group {
        started(group);
    }
    let mut out = child.stdout.take().expect("stdout is piped");
    let mut err = child.stderr.take().expect("stderr is piped");
    let read = |error: io::Error| RunError::Read {
        command: command.clone(),
        message: error.to_string(),
    };

    let work = async {
        let printed = async {
            let mut printed = Vec::new();
            (&mut out)
                .take(MAX_STDOUT + 1)
                .read_to_end(&mut printed)
                .await
                .map_err(read)?;
            if printed.len() as u64 > MAX_STDOUT {
                return Err(RunError::TooMuchOutput(command.clone()));
            }
            Ok(printed)
        };
        let exited = async { child.wait().await.map_err(read) };
        let done = async { tokio::try_join!(printed, exited) };
        let complained = forward(&mut err, &mut stderr);
        tokio::pin!(done, complained);
        let mut closed = false;
        let result = loop {
            tokio::select! {
                result = &mut complained, if !closed => {
                    result.map_err(read)?;
                    closed = true;
                }
                result = &mut done => break result?,
            }
        };
        if !closed {
            // Its error is the reader's, and the run is over.
            closed = tokio::time::timeout(STDERR_GRACE, complained).await.is_ok();
        }
        Ok((result, closed))
    };
    let ended = tokio::select! {
        result = tokio::time::timeout(timeout, work) => match result {
            Ok(Ok(((printed, status), closed))) => Ok((printed, status, closed)),
            Ok(Err(error)) => Err(error),
            Err(_) => Err(RunError::Timeout { command: command.clone(), after: timeout }),
        },
        () = cancel => Err(RunError::Cancelled(command.clone())),
    };
    let (printed, status) = match ended {
        Ok((printed, status, closed)) => {
            if !closed {
                // Read to its end, so a helper that writes to it later
                // gets no broken pipe.
                tokio::spawn(async move {
                    let _ = tokio::io::copy(&mut err, &mut tokio::io::sink()).await;
                });
            }
            (printed, status)
        }
        Err(error) => {
            // The plugin and whatever it started, such as gcloud under
            // gke-gcloud-auth-plugin.
            if let Some(group) = group
                && let Err(kill) = killpg(group, Signal::SIGKILL)
                && kill != nix::errno::Errno::ESRCH
            {
                eprintln!("could not stop {command}: {kill}");
            }
            if let Err(reap) = child.wait().await {
                eprintln!("could not reap {command}: {reap}");
            }
            return Err(error);
        }
    };
    if !status.success() {
        return Err(RunError::Exit {
            command,
            status: describe(status),
        });
    }
    Ok(output::parse(&printed, exec.api_version())?)
}

/// The plugin gets the login shell's environment, then the entry's `env`,
/// then `KUBERNETES_EXEC_INFO`, the last of each name winning, as client-go
/// builds it. A command without a path separator is looked up on that
/// environment's `PATH`.
fn spawn(exec: &Exec, env: &ShellEnv) -> io::Result<tokio::process::Child> {
    let mut command = Command::new(exec.command());
    command
        .args(exec.args())
        .env_clear()
        .envs(env.iter())
        .envs(exec.env().iter().map(|(name, value)| (name, value)))
        .env("KUBERNETES_EXEC_INFO", exec.info())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    command.spawn()
}

async fn forward(
    from: &mut (impl AsyncRead + Unpin),
    to: &mut impl FnMut(&[u8]),
) -> io::Result<()> {
    let mut chunk = [0; 4096];
    loop {
        match from.read(&mut chunk).await? {
            0 => return Ok(()),
            n => to(&chunk[..n]),
        }
    }
}

fn describe(status: ExitStatus) -> String {
    use std::os::unix::process::ExitStatusExt;
    match (status.code(), status.signal()) {
        (Some(code), _) => format!("exit code {code}"),
        (None, Some(signal)) => format!("signal {signal}"),
        (None, None) => status.to_string(),
    }
}
