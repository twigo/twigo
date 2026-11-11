//! The protocol between the Rust core and the webview. `packages/protocol`
//! gets its TypeScript types from these, through [`typescript`].

mod access;
mod action;
mod apply;
mod approval;
pub mod command;
mod credentials;
mod discovery;
mod environment;
mod error;
mod keyboard;
mod list;
mod logs;
mod object;
mod schema;
mod shell;
mod space;
mod state;
mod terminal;
mod typescript;

pub use access::{
    Access, AccessQuery, BlockReason, Blocked, ContextAccess, Environment, Mode, ModeSource,
    RequestClass, SetContextEnvironment, SetContextMode,
};
pub use action::{
    Affected, Execute, Friction, OperationEvent, Plan, PlanId, PlanRequest, ResourceRef,
};
pub use apply::{
    ApplyConflict, ApplyPreviewed, ApplyRequest, ApplyStrategy, OpenedEdit, PreviewId,
};
pub use approval::{
    AnswerApproval, ApprovalAnswer, ApprovalAsk, ApprovalDetail, ApprovalEvent, ApprovalId, NoDiff,
};
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
pub use schema::SchemaQuery;
pub use shell::{
    OpenShell, ShellAck, ShellContainers, ShellEnd, ShellEvent, ShellInput, ShellKind,
    ShellMessage, ShellPod, ShellResize, ShellTarget,
};
pub use space::{Context, ContextColor, Space};
pub use state::{StateEntry, StateSnapshot};
pub use terminal::{
    AnswerKubeconfigOffer, KubeconfigOffer, KubeconfigOfferAnswer, KubeconfigOfferEvent,
    KubeconfigOfferId, NewTerminal, ProxyWhy, TerminalKind, TerminalSession,
};
pub use typescript::typescript;
