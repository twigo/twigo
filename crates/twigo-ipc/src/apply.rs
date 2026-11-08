//! Applying an edit of an object (ARCHITECTURE 6.5): `apply_preview` builds
//! the apply configuration from what Twigo owns plus what the person changed
//! and dry-runs it, and the plan of its id sends what it prepared.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::ResourceRef;

/// What a preview prepared, kept in Rust for the window that asked until a
/// plan takes it (`PlanRequest::Apply`) or the window goes; a newer preview
/// of the same object replaces it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub struct PreviewId(pub u32);

/// The object as it was opened, which an edit is measured against. Its
/// `lock` is apart from `base`: "Keep mine" after a change on the server
/// diffs against the old base and locks to the new version, since diffing
/// against the new live object would revert the other writer's change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct OpenedEdit {
    pub target: ResourceRef,
    /// The object as the webview received it: without managedFields, a
    /// Secret's values masked.
    #[ts(type = "unknown")]
    pub base: Value,
    /// The `resourceVersion` to hold the apply to.
    pub lock: String,
    /// The object as it stood at `lock`, when that is not `base`: "Keep
    /// mine" locks to a newer version than the one edited, and this is what
    /// says a later status write changed nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "unknown")]
    pub locked: Option<Value>,
}

/// An edit to preview, parsed by the webview's YAML parser, so there is one
/// YAML dialect.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ApplyRequest {
    pub space: String,
    /// The object it edits; none for a new manifest, whose object is its
    /// whole configuration and whose resource comes from discovery.
    pub opened: Option<OpenedEdit>,
    /// The object as the person left it.
    #[ts(type = "unknown")]
    pub edited: Value,
    /// Answer conflicts by taking the fields.
    pub force: bool,
    /// The conflicting paths the person gave up, as [`ApplyConflict`] names
    /// them, which leave the configuration.
    pub drop: Vec<String>,
}

/// A field another manager owns that an apply would change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ApplyConflict {
    /// As the server names it: `.spec.replicas`.
    pub path: String,
    pub manager: String,
}

/// How an edit that can go is sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ApplyStrategy {
    /// A server-side apply, and a merge patch for what it leaves.
    ServerSideApply,
    /// One merge patch that carries the changes and the removals together,
    /// as an apply cannot express the edit.
    MergePatch,
}

/// What a dry-run found; a closed set, so the webview cannot miss a case.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ApplyPreviewed {
    /// The edit changes nothing, and nothing was sent.
    Unchanged {
        /// What the edit said that Twigo leaves out: `status`, the
        /// server's metadata.
        ignored: Vec<String>,
    },
    /// The edit can go: both sides of the diff, masked for a Secret, and the
    /// id its plan is asked for by.
    Ready {
        id: PreviewId,
        /// Null for a manifest of a new object.
        #[ts(type = "unknown")]
        live: Value,
        #[ts(type = "unknown")]
        result: Value,
        warnings: Vec<String>,
        /// What goes by a merge patch: a separate step after a
        /// server-side apply, or part of the one patch.
        removals: Vec<String>,
        ignored: Vec<String>,
        strategy: ApplyStrategy,
    },
    Conflicts {
        conflicts: Vec<ApplyConflict>,
    },
    /// The server refused for a `resourceVersion` that is gone, and no
    /// field conflict.
    Stale {
        message: String,
    },
    /// The server refused an immutable field: `recreate` is the id whose
    /// plan deletes and creates it anew, for Pods and Jobs only.
    Immutable {
        message: String,
        recreate: Option<PreviewId>,
    },
}
