use serde_json::json;
use twigo_ipc::{ErrorCode, ErrorKind, IpcError};

use ErrorCode::*;
use ErrorKind::*;

/// A code is never reused or removed, and its wire name and kind never
/// change: a report, an issue or a person's note may name it. A code that
/// no site builds any more stays here, as it is.
const PINNED: &[(ErrorCode, &str, ErrorKind)] = &[
    (ConnectRefused, "connect.refused", Unavailable),
    (ConnectUnresolved, "connect.unresolved", Unavailable),
    (ConnectTimeout, "connect.timeout", Timeout),
    (ConnectCertificate, "connect.certificate", Unavailable),
    (ConnectTls, "connect.tls", Unavailable),
    (ConnectProxy, "connect.proxy", Unavailable),
    (ConnectLost, "connect.lost", Unavailable),
    (ConnectOther, "connect.other", Unavailable),
    (ServerUnauthorized, "server.unauthorized", Unauthorized),
    (ServerForbidden, "server.forbidden", Forbidden),
    (ServerNotFound, "server.not-found", NotFound),
    (ServerConflict, "server.conflict", Conflict),
    (ServerInvalid, "server.invalid", InvalidInput),
    (ServerTimeout, "server.timeout", Timeout),
    (ServerUnavailable, "server.unavailable", Unavailable),
    (ServerOther, "server.other", Internal),
    (CredentialsUntrusted, "credentials.untrusted", Unauthorized),
    (
        CredentialsPluginMissing,
        "credentials.plugin-missing",
        Unauthorized,
    ),
    (
        CredentialsPluginFailed,
        "credentials.plugin-failed",
        Unauthorized,
    ),
    (
        CredentialsPluginTimeout,
        "credentials.plugin-timeout",
        Timeout,
    ),
    (
        CredentialsPluginCancelled,
        "credentials.plugin-cancelled",
        Unauthorized,
    ),
    (
        CredentialsOidcConfig,
        "credentials.oidc-config",
        InvalidInput,
    ),
    (
        CredentialsOidcRefresh,
        "credentials.oidc-refresh",
        Unauthorized,
    ),
    (CredentialsUnusable, "credentials.unusable", Unauthorized),
    (KubeconfigUnreadable, "kubeconfig.unreadable", InvalidInput),
    (KubeconfigUnparsable, "kubeconfig.unparsable", InvalidInput),
    (
        KubeconfigUnmergeable,
        "kubeconfig.unmergeable",
        InvalidInput,
    ),
    (KubeconfigUnwatched, "kubeconfig.unwatched", Unavailable),
    (ContextNotListed, "context.not-listed", NotFound),
    (ContextEmpty, "context.empty", InvalidInput),
    (
        ContextMissingCluster,
        "context.missing-cluster",
        InvalidInput,
    ),
    (ContextMissingUser, "context.missing-user", InvalidInput),
    (ContextInvalid, "context.invalid", InvalidInput),
    (ContextNoPlugin, "context.no-plugin", NotFound),
    (PolicyBlocked, "policy.blocked", Permissions),
    (PolicyFileUnreadable, "policy.file-unreadable", Permissions),
    (PolicyFileSetsMode, "policy.file-sets-mode", Permissions),
    (PolicyNotLocked, "policy.not-locked", InvalidInput),
    (PolicyChanged, "policy.changed", Conflict),
    (AnswerUndecodable, "answer.undecodable", Internal),
    (
        DiscoveryNotAggregated,
        "discovery.not-aggregated",
        Unavailable,
    ),
    (OpenapiNoKind, "openapi.no-kind", NotFound),
    (OpenapiNotListed, "openapi.not-listed", NotFound),
    (OpenapiUnreadable, "openapi.unreadable", Unavailable),
    (EnvironmentUnresolved, "environment.unresolved", Internal),
    (ForwardNotFound, "forward.not-found", NotFound),
    (ForwardInvalidPort, "forward.invalid-port", InvalidInput),
    (ForwardNoPort, "forward.no-port", InvalidInput),
    (
        ForwardUnsupportedTarget,
        "forward.unsupported-target",
        InvalidInput,
    ),
    (ForwardPortInUse, "forward.port-in-use", Conflict),
    (
        ForwardPortNotPermitted,
        "forward.port-not-permitted",
        Conflict,
    ),
    (ForwardListenFailed, "forward.listen-failed", Internal),
    (ForwardNoReadyPod, "forward.no-ready-pod", Unavailable),
    (ForwardPortRefused, "forward.port-refused", Unavailable),
    (
        ForwardWaitingForSlot,
        "forward.waiting-for-slot",
        Unavailable,
    ),
    (
        ForwardClusterUnanswered,
        "forward.cluster-unanswered",
        Unavailable,
    ),
    (TargetGone, "target.gone", NotFound),
    (StateSetAside, "state.set-aside", Internal),
    (StateUnsaved, "state.unsaved", Internal),
    (StateReserved, "state.reserved", Permissions),
    (StateNotJson, "state.not-json", InvalidInput),
    (SpaceNotFound, "space.not-found", NotFound),
    (TrustSetAside, "trust.set-aside", Internal),
    (TrustUnsaved, "trust.unsaved", Internal),
    (AuditOff, "audit.off", Internal),
    (AuditUnwritten, "audit.unwritten", Internal),
    (TokensUnsaved, "tokens.unsaved", Internal),
    (FileUnwritten, "file.unwritten", Internal),
    (FileUnrevealed, "file.unrevealed", Internal),
    (InternalPanic, "internal.panic", Internal),
    (InternalIpc, "internal.ipc", Internal),
    (InternalRequest, "internal.request", Internal),
    (ActionObjectChanged, "action.object-changed", Conflict),
    (ActionClusterChanged, "action.cluster-changed", Conflict),
    (ActionModeChanged, "action.mode-changed", Conflict),
    (ActionKeptChanging, "action.kept-changing", Conflict),
    (ActionNoChange, "action.no-change", InvalidInput),
    (
        ActionUnsupportedKind,
        "action.unsupported-kind",
        InvalidInput,
    ),
    (ActionPaused, "action.paused", InvalidInput),
    (ActionNoTarget, "action.no-target", InvalidInput),
    (ActionMixedTargets, "action.mixed-targets", InvalidInput),
    (ActionUnquotable, "action.unquotable", InvalidInput),
    (ActionDrainRefused, "action.drain-refused", InvalidInput),
    (ApplyInvalidEdit, "apply.invalid-edit", InvalidInput),
    (ApplyMaskedValue, "apply.masked-value", InvalidInput),
    (ApplyWrongTarget, "apply.wrong-target", InvalidInput),
    (ApplyKindNotServed, "apply.kind-not-served", NotFound),
    (ApplyNoObject, "apply.no-object", InvalidInput),
    (
        ApplyIntegerTooLarge,
        "apply.integer-too-large",
        InvalidInput,
    ),
    (ApplyOtherVersion, "apply.other-version", Conflict),
    (UndoNothing, "undo.nothing", NotFound),
    (UndoEnded, "undo.ended", Conflict),
    (TriggerJobExists, "trigger.job-exists", Conflict),
    (BusNotWaiting, "bus.not-waiting", NotFound),
    (BusPreviewReplaced, "bus.preview-replaced", Conflict),
    (WindowGone, "window.gone", Unavailable),
    (SubscriptionNotFound, "subscription.not-found", NotFound),
    (AppQuitting, "app.quitting", Unavailable),
    (ApprovalGone, "approval.gone", NotFound),
    (ApprovalOtherWindow, "approval.other-window", Forbidden),
    (ApprovalUnmarked, "approval.unmarked", InvalidInput),
    (ApprovalMarked, "approval.marked", InvalidInput),
    (ApprovalOnceOnly, "approval.once-only", InvalidInput),
    (ConfirmNameMismatch, "confirm.name-mismatch", InvalidInput),
    (ConfirmCountdown, "confirm.countdown", InvalidInput),
    (OfferGone, "offer.gone", NotFound),
    (OfferOtherWindow, "offer.other-window", Forbidden),
    (OfferAnswering, "offer.answering", Conflict),
    (OfferChanged, "offer.changed", Conflict),
    (OfferLocked, "offer.locked", Conflict),
    (OfferUnmoved, "offer.unmoved", Internal),
    (SessionStarted, "session.started", Conflict),
    (SessionBusy, "session.busy", Timeout),
    (ShellNoContainer, "shell.no-container", NotFound),
    (ShellPodNotRunning, "shell.pod-not-running", Conflict),
    (TerminalStartFailed, "terminal.start-failed", Unavailable),
    (TerminalWaitFailed, "terminal.wait-failed", Internal),
    (
        TerminalKubeconfigPath,
        "terminal.kubeconfig-path",
        InvalidInput,
    ),
    (
        LogsUnsupportedTarget,
        "logs.unsupported-target",
        InvalidInput,
    ),
    (LogsInvalidTime, "logs.invalid-time", InvalidInput),
    (LogsNoPrevious, "logs.no-previous", NotFound),
    (LogsStreamFailed, "logs.stream-failed", Unavailable),
    (LogsDialogFailed, "logs.dialog-failed", Internal),
    (LogsNotAFile, "logs.not-a-file", InvalidInput),
    (FilterInvalidRegex, "filter.invalid-regex", InvalidInput),
    (
        FilterInvalidSelector,
        "filter.invalid-selector",
        InvalidInput,
    ),
    (ObjectNotListed, "object.not-listed", NotFound),
    (ObjectValuesWithheld, "object.values-withheld", Forbidden),
    (SecretNotASecret, "secret.not-a-secret", InvalidInput),
    (SecretNoKey, "secret.no-key", NotFound),
    (ProxyActorRefused, "proxy.actor-refused", InvalidInput),
    (ProxyUnbound, "proxy.unbound", Internal),
    (LinkRefused, "link.refused", InvalidInput),
    (LinkOpenFailed, "link.open-failed", Internal),
    (KeyboardUnavailable, "keyboard.unavailable", Unavailable),
    (KeyboardNotFound, "keyboard.not-found", NotFound),
];

#[test]
fn every_code_keeps_its_wire_name_and_kind() {
    for &(code, wire, kind) in PINNED {
        assert_eq!(serde_json::to_value(code).unwrap(), json!(wire), "{code:?}");
        assert_eq!(
            serde_json::from_value::<ErrorCode>(json!(wire)).unwrap(),
            code,
            "{wire}"
        );
        assert_eq!(code.kind(), kind, "{wire}");
        assert_eq!(code.to_string(), wire, "the log names it as the wire does");
        assert_eq!(IpcError::new(code, "").kind, kind, "{wire}");
    }
}

fn wire_names() -> Vec<String> {
    ErrorCode::ALL
        .iter()
        .map(|code| serde_json::from_value(serde_json::to_value(code).unwrap()).unwrap())
        .collect()
}

#[test]
fn no_code_is_missing_from_the_table_or_named_twice() {
    let pinned: Vec<ErrorCode> = PINNED.iter().map(|&(code, ..)| code).collect();
    for code in ErrorCode::ALL {
        assert!(pinned.contains(code), "{code:?} is not pinned");
    }
    assert_eq!(PINNED.len(), ErrorCode::ALL.len());
    let mut names = wire_names();
    names.sort_unstable();
    let unique = names.len();
    names.dedup();
    assert_eq!(names.len(), unique, "a wire name is used twice");
}

#[test]
fn a_wire_name_is_a_family_and_a_condition() {
    for wire in wire_names() {
        let (family, condition) = wire.split_once('.').expect(&wire);
        let word = |text: &str| {
            !text.is_empty()
                && text
                    .split('-')
                    .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_lowercase()))
        };
        assert!(word(family) && word(condition), "{wire}");
    }
}
