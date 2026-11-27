//! Read-only modes, authorization, approvals, the audit log and redaction
//! (ARCHITECTURE 6.4): modes and the person's protection file that keeps
//! their choices, the gate every client carries, the approval a proxied
//! request carries through it, the friction a command asks for, the audit
//! log and redaction.

mod actor;
mod approval;
mod attributes;
mod audit;
mod file;
pub mod friction;
mod gate;
mod policy;
mod protection;
pub mod redact;
mod served;

pub use actor::Actor;
pub use approval::Approval;
pub use attributes::Attributes;
pub use audit::{Audit, By, Entry, On, Why};
pub use file::PolicyFile;
pub use gate::{Gate, GateLayer, Gated, RecheckLayer, Rechecked};
pub use policy::{
    Beneath, Change, Metadata, Outlived, PlannedChange, Policy, ProviderLock, Refused, StartOver,
    TypeLock, UNLOCK,
};
pub use protection::{Choices, Protection};
pub use served::{Served, Server, api_service};
