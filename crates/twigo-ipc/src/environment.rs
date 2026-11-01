use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Where the login shell's environment stands (ARCHITECTURE 6.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ShellEnvironment {
    Resolving,
    Resolved,
    /// Twigo runs child processes with its own environment, which on a Dock
    /// launch has launchd's minimal `PATH`.
    Failed {
        /// The shell's path, such as `/bin/zsh`.
        shell: String,
        /// What went wrong, worded to follow the shell's path: `did not answer in 10 s`.
        reason: String,
        /// The end of what the shell printed, the environment left out.
        output: String,
    },
}
