//! The protocol between the Rust core and the webview. `packages/protocol`
//! gets its TypeScript types from these, through [`typescript`].

pub mod command;
mod error;
mod list;
mod space;
mod typescript;

pub use error::{ErrorKind, IpcError};
pub use list::{
    Ack, Cell, Column, ColumnKind, Gvr, ListBatch, ListQuery, Row, RowId, SetWindow, Sort,
    SubscriptionId, ViewState, Window,
};
pub use space::{Context, ContextColor, Space};
pub use typescript::typescript;
