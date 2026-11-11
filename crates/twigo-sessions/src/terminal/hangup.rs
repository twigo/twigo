//! Closing a terminal hangs up what runs on it: `SIGHUP` to the shell's
//! process group and to the terminal's foreground group, then `SIGKILL` 3 s
//! later to whichever still has a process, as a program may ignore the
//! hangup. A job moved out of both groups, as `nohup … &` under job control
//! moves it, is left running, as any terminal leaves it.
//!
//! Only a shell nobody has reaped is signalled, as another process may have
//! the pid of one reaped: the poll that reaps it ends the hangup under the
//! same lock, and the kill keeps it unreaped through the grace, so its pid
//! and its group's id stay its own.

use std::io;
use std::os::fd::OwnedFd;
use std::pin::pin;
use std::process::ExitStatus;
use std::sync::Mutex;
use std::task::Poll;
use std::time::Duration;

use nix::errno::Errno;
use nix::sys::signal::{Signal, killpg};
use nix::unistd::{Pid, tcgetpgrp};
use tokio::process::Child;
use tokio::runtime::Handle;

const GRACE: Duration = Duration::from_secs(3);

pub(super) struct Hangup {
    state: Mutex<State>,
    /// The terminal's, for the kill after the grace.
    runtime: Handle,
}

enum State {
    /// Unreaped: it runs, or it has ended unseen.
    Running {
        shell: Child,
        /// The leader of its session and of its process group.
        pid: Pid,
        pty: Descriptors,
    },
    /// Reaped, so its pid may be another process's by now.
    Ended {
        _pty: Descriptors,
    },
    HungUp,
}

/// Twigo's copies of the pty's two sides.
struct Descriptors {
    master: OwnedFd,
    _slave: OwnedFd,
}

impl Hangup {
    pub(super) fn new(shell: Child, master: OwnedFd, slave: OwnedFd) -> Self {
        let id = shell
            .id()
            .expect("a child is not reaped before it is waited for");
        Self {
            state: Mutex::new(State::Running {
                shell,
                pid: Pid::from_raw(i32::try_from(id).expect("a pid fits an i32")),
                pty: Descriptors {
                    master,
                    _slave: slave,
                },
            }),
            runtime: Handle::current(),
        }
    }

    /// The shell's exit, which no hangup follows. Never ends once the
    /// terminal has been hung up.
    pub(super) async fn exit(&self) -> io::Result<ExitStatus> {
        std::future::poll_fn(|cx| {
            let mut state = self.state.lock().expect("hangup lock");
            let State::Running { shell, .. } = &mut *state else {
                return Poll::Pending;
            };
            let polled = pin!(shell.wait()).poll(cx);
            if polled.is_ready() {
                let State::Running { pty, .. } = std::mem::replace(&mut *state, State::HungUp)
                else {
                    unreachable!("matched above");
                };
                *state = State::Ended { _pty: pty };
            }
            polled
        })
        .await
    }

    /// Never blocks: the kill is a task on the terminal's runtime, which a
    /// runtime shut down, as at quit, drops unrun.
    pub(super) fn hang_up(&self) {
        let state = std::mem::replace(&mut *self.state.lock().expect("hangup lock"), State::HungUp);
        let State::Running { shell, pid, pty } = state else {
            return;
        };
        let mut groups = vec![pid];
        if let Ok(foreground) = tcgetpgrp(&pty.master)
            && foreground.as_raw() > 0
            && foreground != pid
        {
            groups.push(foreground);
        }
        for group in &groups {
            send(*group, Signal::SIGHUP);
        }
        drop(pty);
        self.runtime.spawn(async move {
            tokio::time::sleep(GRACE).await;
            for group in groups {
                if killpg(group, None).is_ok() {
                    send(group, Signal::SIGKILL);
                }
            }
            drop(shell);
        });
    }
}

fn send(group: Pid, signal: Signal) {
    match killpg(group, signal) {
        Ok(()) | Err(Errno::ESRCH) => {}
        Err(error) => eprintln!("could not send {signal} to the process group {group}: {error}"),
    }
}
