use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::Blocked;

/// The error every command returns, and every state that holds a failure.
///
/// `code` names the condition and is what a person reads, searches and
/// copies, and what a test holds; `kind` is its class, derived from it,
/// which retries, sign-ins and refusals branch on; `message` is for people
/// and is never matched. The core branches on `kind`, the webview on `code`
/// where one condition matters and on `kind` where a class does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[non_exhaustive]
pub struct IpcError {
    pub code: ErrorCode,
    pub kind: ErrorKind,
    pub message: String,
    /// With `permissions`: the mode and its source, when the gate stopped a
    /// request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub blocked: Option<Box<Blocked>>,
    /// With a request the API server answered: its status, as data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub server: Option<ServerStatus>,
}

impl IpcError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            kind: code.kind(),
            message: message.into(),
            blocked: None,
            server: None,
        }
    }

    pub fn with_server(mut self, server: ServerStatus) -> Self {
        self.server = Some(server);
        self
    }
}

impl From<Blocked> for IpcError {
    fn from(blocked: Blocked) -> Self {
        let mut error = Self::new(ErrorCode::PolicyBlocked, blocked.to_string());
        error.blocked = Some(Box::new(blocked));
        error
    }
}

/// What the API server said of a request it refused, beside Twigo's own
/// code. The reason is the server's, an open set that an aggregated API or
/// a webhook may answer any string for, so it is never a Twigo code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ServerStatus {
    /// The `reason` of the `Status`: `Forbidden`, `AlreadyExists`, `Invalid`;
    /// empty when the server gave none.
    pub reason: String,
    pub causes: Vec<ServerCause>,
}

/// One cause of an `Invalid` status, as kubectl prints it: `field: message`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ServerCause {
    pub reason: String,
    /// `spec.replicas`; empty when the cause names no field.
    pub field: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    InvalidInput,
    NotFound,
    Conflict,
    Forbidden,
    Unauthorized,
    /// Twigo's own policy refused it, where `Forbidden` is the cluster's RBAC.
    Permissions,
    Timeout,
    Unavailable,
    Internal,
}

/// Declares [`ErrorCode`] from one table: a variant, its wire name and its
/// kind.
macro_rules! error_codes {
    ($($(#[$doc:meta])* $variant:ident = $wire:literal, $kind:ident;)*) => {
        /// Why something failed, named by a condition: `family.condition`.
        ///
        /// A wire name is written out for each code, so renaming a variant
        /// never moves it, and it is never reused or removed: a code that no
        /// site builds any more stays, as a report or an issue may still name
        /// it. The test `error_codes` pins every name and kind.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
        pub enum ErrorCode {
            $($(#[$doc])* #[serde(rename = $wire)] $variant,)*
        }

        impl ErrorCode {
            /// Every code, in the order they are declared.
            pub const ALL: &'static [ErrorCode] = &[$(ErrorCode::$variant),*];

            /// The class of the condition.
            pub const fn kind(self) -> ErrorKind {
                match self {
                    $(ErrorCode::$variant => ErrorKind::$kind,)*
                }
            }

            /// The wire name: `connect.refused`.
            pub const fn wire(self) -> &'static str {
                match self {
                    $(ErrorCode::$variant => $wire,)*
                }
            }
        }

        impl std::fmt::Display for ErrorCode {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.wire())
            }
        }
    };
}

error_codes! {
    // The cluster does not answer, or the connection to it breaks.
    ConnectRefused = "connect.refused", Unavailable;
    ConnectUnresolved = "connect.unresolved", Unavailable;
    ConnectTimeout = "connect.timeout", Timeout;
    ConnectCertificate = "connect.certificate", Unavailable;
    ConnectTls = "connect.tls", Unavailable;
    ConnectProxy = "connect.proxy", Unavailable;
    ConnectLost = "connect.lost", Unavailable;
    ConnectOther = "connect.other", Unavailable;

    // The API server answered with a status, by its HTTP code.
    ServerUnauthorized = "server.unauthorized", Unauthorized;
    ServerForbidden = "server.forbidden", Forbidden;
    ServerNotFound = "server.not-found", NotFound;
    ServerConflict = "server.conflict", Conflict;
    ServerInvalid = "server.invalid", InvalidInput;
    ServerTimeout = "server.timeout", Timeout;
    ServerUnavailable = "server.unavailable", Unavailable;
    ServerOther = "server.other", Internal;

    // The request got no credential.
    CredentialsUntrusted = "credentials.untrusted", Unauthorized;
    CredentialsPluginMissing = "credentials.plugin-missing", Unauthorized;
    CredentialsPluginFailed = "credentials.plugin-failed", Unauthorized;
    CredentialsPluginTimeout = "credentials.plugin-timeout", Timeout;
    CredentialsPluginCancelled = "credentials.plugin-cancelled", Unauthorized;
    CredentialsOidcConfig = "credentials.oidc-config", InvalidInput;
    CredentialsOidcRefresh = "credentials.oidc-refresh", Unauthorized;
    CredentialsUnusable = "credentials.unusable", Unauthorized;

    // The kubeconfig files.
    KubeconfigUnreadable = "kubeconfig.unreadable", InvalidInput;
    KubeconfigUnparsable = "kubeconfig.unparsable", InvalidInput;
    KubeconfigUnmergeable = "kubeconfig.unmergeable", InvalidInput;
    KubeconfigUnwatched = "kubeconfig.unwatched", Unavailable;

    // A context of the catalog.
    ContextNotListed = "context.not-listed", NotFound;
    ContextEmpty = "context.empty", InvalidInput;
    ContextMissingCluster = "context.missing-cluster", InvalidInput;
    ContextMissingUser = "context.missing-user", InvalidInput;
    /// Its kubeconfig entry cannot build clients.
    ContextInvalid = "context.invalid", InvalidInput;
    ContextNoPlugin = "context.no-plugin", NotFound;

    // Twigo's policy and the changes of a context's mode.
    PolicyBlocked = "policy.blocked", Permissions;
    PolicyFileUnreadable = "policy.file-unreadable", Permissions;
    PolicyFileSetsMode = "policy.file-sets-mode", Permissions;
    PolicyNotLocked = "policy.not-locked", InvalidInput;
    PolicyChanged = "policy.changed", Conflict;

    // What the server or the cluster answered that Twigo cannot use.
    AnswerUndecodable = "answer.undecodable", Internal;
    DiscoveryNotAggregated = "discovery.not-aggregated", Unavailable;
    OpenapiNoKind = "openapi.no-kind", NotFound;
    OpenapiNotListed = "openapi.not-listed", NotFound;
    OpenapiUnreadable = "openapi.unreadable", Unavailable;

    ExecFailed = "exec.failed", Unavailable;

    // Port forwards.
    ForwardNotFound = "forward.not-found", NotFound;
    ForwardInvalidPort = "forward.invalid-port", InvalidInput;
    ForwardNoPort = "forward.no-port", InvalidInput;
    ForwardUnsupportedTarget = "forward.unsupported-target", InvalidInput;
    ForwardPortInUse = "forward.port-in-use", Conflict;
    ForwardPortNotPermitted = "forward.port-not-permitted", Conflict;
    ForwardListenFailed = "forward.listen-failed", Internal;
    ForwardNoReadyPod = "forward.no-ready-pod", Unavailable;
    ForwardPortRefused = "forward.port-refused", Unavailable;
    ForwardWaitingForSlot = "forward.waiting-for-slot", Unavailable;
    ForwardClusterUnanswered = "forward.cluster-unanswered", Unavailable;

    /// The object that a session follows is gone.
    TargetGone = "target.gone", NotFound;

    // Twigo's own files, which fail without a request.
    StateSetAside = "state.set-aside", Internal;
    StateUnsaved = "state.unsaved", Internal;
    StateReserved = "state.reserved", Permissions;
    StateNotJson = "state.not-json", InvalidInput;
    SpaceNotFound = "space.not-found", NotFound;
    TrustSetAside = "trust.set-aside", Internal;
    TrustUnsaved = "trust.unsaved", Internal;
    AuditOff = "audit.off", Internal;
    AuditUnwritten = "audit.unwritten", Internal;
    TokensUnsaved = "tokens.unsaved", Internal;
    FileUnwritten = "file.unwritten", Internal;
    FileUnrevealed = "file.unrevealed", Internal;

    InternalPanic = "internal.panic", Internal;
    InternalIpc = "internal.ipc", Internal;
    /// A request that Rust refuses or cannot build: what the webview sent
    /// that no window sends.
    InternalRequest = "internal.request", Internal;

    // The outcomes of commands that change a cluster.
    /// The object was replaced or changed since the person looked.
    ActionObjectChanged = "action.object-changed", Conflict;
    ActionClusterChanged = "action.cluster-changed", Conflict;
    ActionModeChanged = "action.mode-changed", Conflict;
    ActionKeptChanging = "action.kept-changing", Conflict;
    /// It is so already, or there is nothing to do.
    ActionNoChange = "action.no-change", InvalidInput;
    ActionUnsupportedKind = "action.unsupported-kind", InvalidInput;
    ActionPaused = "action.paused", InvalidInput;
    ActionNoTarget = "action.no-target", InvalidInput;
    ActionMixedTargets = "action.mixed-targets", InvalidInput;
    ActionUnquotable = "action.unquotable", InvalidInput;
    ActionDrainRefused = "action.drain-refused", InvalidInput;
    ApplyInvalidEdit = "apply.invalid-edit", InvalidInput;
    ApplyMaskedValue = "apply.masked-value", InvalidInput;
    ApplyWrongTarget = "apply.wrong-target", InvalidInput;
    ApplyKindNotServed = "apply.kind-not-served", NotFound;
    ApplyNoObject = "apply.no-object", InvalidInput;
    ApplyIntegerTooLarge = "apply.integer-too-large", InvalidInput;
    ApplyOtherVersion = "apply.other-version", Conflict;
    UndoNothing = "undo.nothing", NotFound;
    UndoEnded = "undo.ended", Conflict;
    TriggerJobExists = "trigger.job-exists", Conflict;
    BusNotWaiting = "bus.not-waiting", NotFound;
    BusPreviewReplaced = "bus.preview-replaced", Conflict;
    WindowGone = "window.gone", Unavailable;
    SubscriptionNotFound = "subscription.not-found", NotFound;
    AppQuitting = "app.quitting", Unavailable;

    // The person's answers.
    ApprovalGone = "approval.gone", NotFound;
    ApprovalOtherWindow = "approval.other-window", Forbidden;
    ApprovalUnmarked = "approval.unmarked", InvalidInput;
    ApprovalMarked = "approval.marked", InvalidInput;
    ApprovalOnceOnly = "approval.once-only", InvalidInput;
    ConfirmNameMismatch = "confirm.name-mismatch", InvalidInput;
    ConfirmCountdown = "confirm.countdown", InvalidInput;
    OfferGone = "offer.gone", NotFound;
    OfferOtherWindow = "offer.other-window", Forbidden;
    OfferAnswering = "offer.answering", Conflict;
    OfferChanged = "offer.changed", Conflict;
    OfferLocked = "offer.locked", Conflict;
    OfferUnmoved = "offer.unmoved", Internal;

    // Sessions: shells, terminals and logs.
    SessionStarted = "session.started", Conflict;
    SessionBusy = "session.busy", Timeout;
    ShellNoContainer = "shell.no-container", NotFound;
    ShellPodNotRunning = "shell.pod-not-running", Conflict;
    TerminalStartFailed = "terminal.start-failed", Unavailable;
    TerminalWaitFailed = "terminal.wait-failed", Internal;
    TerminalKubeconfigPath = "terminal.kubeconfig-path", InvalidInput;
    LogsUnsupportedTarget = "logs.unsupported-target", InvalidInput;
    LogsInvalidTime = "logs.invalid-time", InvalidInput;
    LogsNoPrevious = "logs.no-previous", NotFound;
    LogsStreamFailed = "logs.stream-failed", Unavailable;
    LogsDialogFailed = "logs.dialog-failed", Internal;
    LogsNotAFile = "logs.not-a-file", InvalidInput;

    FilterInvalidRegex = "filter.invalid-regex", InvalidInput;
    FilterInvalidSelector = "filter.invalid-selector", InvalidInput;

    ObjectNotListed = "object.not-listed", NotFound;
    ObjectValuesWithheld = "object.values-withheld", Forbidden;
    SecretNotASecret = "secret.not-a-secret", InvalidInput;
    SecretNoKey = "secret.no-key", NotFound;

    ProxyActorRefused = "proxy.actor-refused", InvalidInput;
    ProxyUnbound = "proxy.unbound", Internal;
    LinkRefused = "link.refused", InvalidInput;
    LinkOpenFailed = "link.open-failed", Internal;
    KeyboardUnavailable = "keyboard.unavailable", Unavailable;
    KeyboardNotFound = "keyboard.not-found", NotFound;
}
