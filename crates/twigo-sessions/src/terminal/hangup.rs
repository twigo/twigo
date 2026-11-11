//! Closing a terminal hangs up what runs on it: `SIGHUP` to the shell's
//! process group and to the terminal's foreground group, then `SIGKILL` 3 s
//! later to whichever still has a process, as a program may ignore the
//! hangup. A job moved out of both groups, as `nohup … &` under job control
//! moves it, is left running, as any terminal leaves it.

use std::os::fd::OwnedFd;
use std::time::Duration;

use nix::errno::Errno;
use nix::sys::signal::{Signal, killpg};
use nix::unistd::{Pid, tcgetpgrp};
use tokio::runtime::Handle;

const GRACE: Duration = Duration::from_secs(3);

pub(super) struct Hangup {
    /// The leader of its session and of its process group.
    shell: Pid,
    master: OwnedFd,
    slave: OwnedFd,
    /// The terminal's, for the kill after the grace.
    runtime: Handle,
}

impl Hangup {
    pub(super) fn new(shell: Pid, master: OwnedFd, slave: OwnedFd) -> Self {
        Self {
            shell,
            master,
            slave,
            runtime: Handle::current(),
        }
    }

    /// Never blocks: the kill is a task on the terminal's runtime, which a
    /// runtime shutting down, as at quit, drops unrun.
    pub(super) fn hang_up(self) {
        let Self {
            shell,
            master,
            slave,
            runtime,
        } = self;
        let mut groups = vec![shell];
        if let Ok(foreground) = tcgetpgrp(&master)
            && foreground.as_raw() > 0
            && foreground != shell
        {
            groups.push(foreground);
        }
        for group in &groups {
            send(*group, Signal::SIGHUP);
        }
        drop((master, slave));
        runtime.spawn(async move {
            tokio::time::sleep(GRACE).await;
            for group in groups {
                if killpg(group, None).is_ok() {
                    send(group, Signal::SIGKILL);
                }
            }
        });
    }
}

fn send(group: Pid, signal: Signal) {
    match killpg(group, signal) {
        Ok(()) | Err(Errno::ESRCH) => {}
        Err(error) => eprintln!("could not send {signal} to the process group {group}: {error}"),
    }
}
