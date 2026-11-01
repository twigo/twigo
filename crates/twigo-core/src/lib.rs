//! App services: the catalog, spaces and the state store, which the Tauri
//! app turns into commands.

pub mod catalog;
pub mod state;

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use jiff::Timestamp;
use tokio::sync::watch;
use twigo_env::Status;

use catalog::Catalog;
use state::State;

pub struct Core {
    pub state: State,
    pub catalog: Catalog,
}

impl Core {
    pub fn new(state_file: PathBuf) -> Self {
        Self {
            state: State::open(state_file),
            catalog: Catalog::default(),
        }
    }

    /// Follows the catalog's sources and tells the state store which
    /// contexts they list; never returns. In the explicit mode (ARCHITECTURE
    /// 5.5) `explicit` is the only source; otherwise the sources come from
    /// the login shell's environment, as `status` follows it, read again
    /// whenever it is resolved.
    pub async fn run(&self, mut status: watch::Receiver<Status>, explicit: Option<PathBuf>) {
        let sources = async {
            if let Some(file) = explicit {
                self.catalog
                    .follow(catalog::sources(Some(file), None, None));
                return;
            }
            loop {
                let env = match &*status.borrow_and_update() {
                    Status::Resolving => None,
                    Status::Resolved(env) | Status::Failed { env, .. } => Some(env.clone()),
                };
                if let Some(env) = env {
                    let home = env.get("HOME").map(Path::new);
                    self.catalog
                        .follow(catalog::sources(None, env.get("KUBECONFIG"), home));
                }
                if status.changed().await.is_err() {
                    return;
                }
            }
        };
        let seen = async {
            let mut contexts = self.catalog.subscribe();
            loop {
                let listed = contexts.borrow_and_update().clone();
                if let Some(listed) = listed {
                    let names: HashSet<String> = listed.iter().map(|c| c.name.clone()).collect();
                    self.state.saw(&names, Timestamp::now());
                }
                if contexts.changed().await.is_err() {
                    return;
                }
            }
        };
        tokio::join!(sources, seen);
    }
}

#[cfg(test)]
mod tests;
