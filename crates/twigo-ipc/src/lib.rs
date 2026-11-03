//! The protocol between the Rust core and the webview. `packages/protocol`
//! gets its TypeScript types from these, through [`typescript`].

pub mod command;
mod credentials;
mod discovery;
mod environment;
mod error;
mod keyboard;
mod list;
mod logs;
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
    Ack, Cell, Column, ColumnKind, ColumnValues, Grouping, Gvr, ListBatch, ListQuery, Row,
    RowGroup, RowId, SetWindow, Sort, SubscriptionId, ValueCount, ViewState, Window,
};
pub use logs::{
    AnsiColor, Bucket, Containers, DownloadLogs, Histogram, Level, LevelFilter, LogAround,
    LogBatch, LogContainer, LogEntries, LogEntry, LogMatches, LogPod, LogSource, LogTarget,
    LogView, LogWindow, OpenLogs, SetLogSource, SetLogView, SetLogWindow, Since, StreamState,
    TextRange, TextStyle, TimeRange,
};
pub use object::{
    Block, Condition, Container, ContainerRole, ContainerState, DataEntry, EmbeddedList, EventList,
    Field, Finding, FindingLogs, GetValues, Label, ObjectBatch, ObjectEvent, ObjectParts,
    ObjectQuery, ObjectRef, OpenObject, Overview, Related, RelatedObject, Section, SetParts, Span,
    Tone, TreeNode, TreeValue, Value,
};
pub use space::{Context, ContextColor, Space};
pub use state::{StateEntry, StateSnapshot};
pub use typescript::typescript;
