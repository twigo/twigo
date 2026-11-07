//! Who is asking (ARCHITECTURE 6.4), which the layer knows from the clients
//! the request came through.

use twigo_ipc::{BlockReason, Mode, RequestClass};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Actor {
    /// The webview's views and commands, the hub and discovery. Its commands
    /// confirm above the layer.
    Ui,
    /// A terminal, reading Secrets as the user's own shell does.
    Terminal,
    /// `helm`, whose release storage is Secrets.
    Helm,
    /// Twigo's MCP tools, which read inside the core and return keys and
    /// sizes only.
    Mcp,
    Extension {
        /// Its named `secrets` grant.
        secrets: bool,
    },
    Agent,
}

impl Actor {
    /// What the mode does with the class: reads and dry runs always pass,
    /// and the class of reading a Secret is the actor's, not the mode's.
    pub(crate) fn decide(
        self,
        class: RequestClass,
        mode: Mode,
        allow_port_forward: bool,
    ) -> Result<(), BlockReason> {
        match (class, mode) {
            (RequestClass::Read | RequestClass::DryRun, _) => Ok(()),
            (RequestClass::SecretRead, _) => self.read_secrets(),
            (_, Mode::ReadWrite) | (RequestClass::Forward, Mode::Guarded) => Ok(()),
            (RequestClass::Forward, Mode::ReadOnly) if allow_port_forward => Ok(()),
            (RequestClass::Write | RequestClass::Exec, Mode::Guarded) if self == Actor::Ui => {
                Ok(())
            }
            (RequestClass::Write | RequestClass::Exec, Mode::Guarded) => {
                Err(BlockReason::NoApproval)
            }
            (_, Mode::ReadOnly) => Err(BlockReason::Mode),
        }
    }

    pub(crate) fn read_secrets(self) -> Result<(), BlockReason> {
        match self {
            Actor::Ui | Actor::Terminal | Actor::Helm | Actor::Mcp => Ok(()),
            Actor::Extension { secrets: true } => Ok(()),
            Actor::Extension { secrets: false } => Err(BlockReason::NoGrant),
            Actor::Agent => Err(BlockReason::NoApproval),
        }
    }
}
