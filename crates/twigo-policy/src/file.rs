//! The admin's policy file (ARCHITECTURE 4.8, 6.4), which the UI cannot
//! change: modes by context glob, whether `read-only` allows
//! port-forwarding, and the contexts whose terminals go through the policy
//! proxy whatever their mode.
//!
//! ```json
//! {
//!   "contexts": { "prod-*": "read-only", "staging-*": "guarded" },
//!   "readOnly": { "allowPortForward": false },
//!   "terminal": { "usePolicyProxy": ["prod-*"] }
//! }
//! ```

use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use glob::{MatchOptions, Pattern};
use serde::Deserialize;
use twigo_ipc::{Mode, ModeSource};

/// A key nothing reads would be a lock that does not hold, so an unknown one
/// makes the file unreadable.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Shape {
    #[serde(default)]
    contexts: BTreeMap<String, Mode>,
    #[serde(default, rename = "readOnly")]
    read_only: ReadOnly,
    #[serde(default)]
    terminal: Terminal,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Terminal {
    #[serde(default)]
    use_policy_proxy: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReadOnly {
    #[serde(default = "allowed")]
    allow_port_forward: bool,
}

impl Default for ReadOnly {
    fn default() -> Self {
        Self {
            allow_port_forward: allowed(),
        }
    }
}

fn allowed() -> bool {
    true
}

#[derive(Debug, Clone, Default)]
pub struct PolicyFile {
    /// Named in what the UI says about a mode.
    file: String,
    state: State,
}

#[derive(Debug, Clone)]
enum State {
    Read {
        entries: Vec<(Pattern, Mode)>,
        allow_port_forward: bool,
        proxied: Vec<Pattern>,
    },
    /// The admin meant something the file does not say, so every context is
    /// `read-only` until it reads again.
    Unreadable,
}

impl Default for State {
    fn default() -> Self {
        State::Read {
            entries: Vec::new(),
            allow_port_forward: allowed(),
            proxied: Vec::new(),
        }
    }
}

impl PolicyFile {
    /// Where an admin puts it on this system.
    pub fn default_path() -> PathBuf {
        if cfg!(target_os = "macos") {
            PathBuf::from("/Library/Application Support/Twigo/policy.json")
        } else {
            PathBuf::from("/etc/twigo/policy.json")
        }
    }

    /// Reads the file once, as the app starts. A missing file sets nothing.
    pub fn read(path: &Path) -> Self {
        let file = path.display().to_string();
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return Self {
                    file,
                    state: State::default(),
                };
            }
            Err(error) => {
                eprintln!("could not read {file}, so every context is read-only: {error}");
                return Self {
                    file,
                    state: State::Unreadable,
                };
            }
        };
        match Self::parse(&text) {
            Ok(state) => Self { file, state },
            Err(error) => {
                eprintln!("could not read {file}, so every context is read-only: {error}");
                Self {
                    file,
                    state: State::Unreadable,
                }
            }
        }
    }

    fn parse(text: &str) -> Result<State, String> {
        let shape: Shape = serde_json::from_str(text).map_err(|error| error.to_string())?;
        let glob =
            |pattern: &str| Pattern::new(pattern).map_err(|error| format!("{pattern}: {error}"));
        let mut entries = Vec::with_capacity(shape.contexts.len());
        for (pattern, mode) in shape.contexts {
            entries.push((glob(&pattern)?, mode));
        }
        let proxied = shape
            .terminal
            .use_policy_proxy
            .iter()
            .map(|pattern| glob(pattern))
            .collect::<Result<_, _>>()?;
        Ok(State::Read {
            entries,
            allow_port_forward: shape.read_only.allow_port_forward,
            proxied,
        })
    }

    /// The mode the file sets for `context`: of several entries that match,
    /// the strictest, so their order means nothing.
    pub(crate) fn mode(&self, context: &str) -> Option<(Mode, ModeSource)> {
        let entries = match &self.state {
            State::Read { entries, .. } => entries,
            State::Unreadable => {
                return Some((
                    Mode::ReadOnly,
                    ModeSource::PolicyFile {
                        file: self.file.clone(),
                        pattern: None,
                    },
                ));
            }
        };
        entries
            .iter()
            .filter(|(pattern, _)| matches(pattern, context))
            .max_by_key(|(_, mode)| *mode)
            .map(|(pattern, mode)| {
                (
                    *mode,
                    ModeSource::PolicyFile {
                        file: self.file.clone(),
                        pattern: Some(pattern.as_str().to_owned()),
                    },
                )
            })
    }

    pub(crate) fn allow_port_forward(&self) -> bool {
        match &self.state {
            State::Read {
                allow_port_forward, ..
            } => *allow_port_forward,
            State::Unreadable => false,
        }
    }

    /// Whether the file has `context`'s terminals go through the policy
    /// proxy; one that cannot be read has every terminal do so.
    pub(crate) fn uses_policy_proxy(&self, context: &str) -> bool {
        match &self.state {
            State::Read { proxied, .. } => proxied.iter().any(|pattern| matches(pattern, context)),
            State::Unreadable => true,
        }
    }
}

fn matches(pattern: &Pattern, context: &str) -> bool {
    // A context's name may hold slashes: an EKS ARN's does.
    let options = MatchOptions {
        case_sensitive: true,
        require_literal_separator: false,
        require_literal_leading_dot: false,
    };
    pattern.matches_with(context, options)
}
