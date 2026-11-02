//! The protocol between the Rust core and the webview. `packages/protocol`
//! gets its TypeScript types from these, through [`typescript`].

pub mod command;
mod credentials;
mod discovery;
mod environment;
mod error;
mod keyboard;
mod list;
mod object;
mod space;
mod state;
mod typescript;

pub use credentials::{ContextAuth, EnvVar, ExecPlugin, ExecReview, PluginStatus, ReviewedPlugin};
pub use discovery::{ClusterVersion, Discovered, Resource};
pub use environment::ShellEnvironment;
pub use error::{ErrorKind, IpcError};
pub use keyboard::{KeyMapping, KeyboardLayout};
pub use list::{
    Ack, Cell, Column, ColumnKind, ColumnValues, GroupCount, Gvr, ListBatch, ListQuery, Row, RowId,
    SetWindow, Sort, SubscriptionId, ViewState, Window,
};
pub use object::{
    Block, Condition, DataEntry, EventList, Field, GetValues, Label, ObjectBatch, ObjectEvent,
    ObjectParts, ObjectQuery, ObjectRef, OpenObject, Overview, Related, RelatedObject, Section,
    SetParts, Tone, TreeNode, TreeValue, Value,
};
pub use space::{Context, ContextColor, Space};
pub use state::{StateEntry, StateSnapshot};
pub use typescript::typescript;
