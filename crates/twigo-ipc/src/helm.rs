//! Helm releases, read only (ARCHITECTURE 3.6, 7.1): the releases of a space's
//! namespaces as a list, and one release's revisions, decoded in Rust from the
//! Secrets Helm keeps them in. Values, the Secrets of a manifest, the notes and
//! a revision's description are secret-grade: they leave Rust masked, and a
//! Reveal shows one part of the revision an editor shows.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    ColumnValues, DataEntry, Grouping, IpcError, Overview, Sort, SubscriptionId, ViewState,
};

/// The releases of a space's namespaces, one row a release, which is its
/// latest revision: Name and Revision from the labels Helm sets on its
/// Secrets, Status from the `status` label until that revision is decoded and
/// the release's own after, as `helm list` prints it, or `unreadable` where
/// what the revision's Secret holds cannot be read, and Chart
/// (`name-version`), App Version and Updated once that revision is decoded.
/// Helm writes a revision's Secret again when its status changes: until the
/// new version is decoded, Chart, App Version and Updated stay and Status is
/// the label's. Updated is an `age` column that reads the row's `created`,
/// the revision's `info.last_deployed`; Problem holds the wire name of the
/// code that keeps the revision from being read, as
/// [`ReleaseBatch::problem`] tells them, and is empty when it is read: a
/// request that fails keeps the label's Status. Its batches are
/// [`ListBatch`](crate::ListBatch)es, and `list_set_window`, `list_ack` and
/// `list_unsubscribe` serve it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseListQuery {
    pub space: String,
    /// As in [`ListQuery`](crate::ListQuery), for the namespaces where the
    /// person may list Secrets.
    pub namespaces: Vec<String>,
    /// As in [`ListQuery`](crate::ListQuery) from here on.
    pub text: Option<String>,
    pub columns: Option<BTreeMap<String, bool>>,
    pub sort: Option<Sort>,
    pub count_by: Option<String>,
    pub group_by: Option<Grouping>,
    pub values: Option<ColumnValues>,
}

/// One release: the namespace of its Secrets and its name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ReleaseRef {
    pub space: String,
    pub namespace: String,
    pub name: String,
}

/// What the views of an open release ask for; Rust decodes and sends only
/// these.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ReleaseParts {
    /// The shown revision's overview, notes and description, on every view.
    pub overview: bool,
    /// Its values, the person's and the chart's defaults, while the Values
    /// view is shown.
    pub values: bool,
    /// Its manifest, while the Manifest view is shown.
    pub manifest: bool,
    /// A line for each revision Helm keeps, while History is shown.
    pub history: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct OpenRelease {
    pub release: ReleaseRef,
    /// The revision to show; null follows the latest.
    pub revision: Option<u32>,
    pub parts: ReleaseParts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SetReleaseView {
    pub id: SubscriptionId,
    /// The revision to show; null follows the latest.
    pub revision: Option<u32>,
    pub parts: ReleaseParts,
}

/// One flush of an open release. Rust sends the next only after the webview
/// acknowledged this one's `seq`, and coalesces changes meanwhile; a part is
/// present when it changed, while it is asked for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ReleaseBatch {
    pub seq: u32,
    /// The state of the Secrets of the release's namespace, as a list's.
    pub status: ViewState,
    /// False until a revision is listed, and once none is left, as after an
    /// uninstall without `--keep-history`.
    pub exists: bool,
    /// The revision the parts are of: the one asked for, else the latest.
    pub revision: Option<u32>,
    /// The highest revision Helm keeps, which `helm get` reads.
    pub latest: Option<u32>,
    /// The highest revision Helm keeps below `revision`, from the labels of
    /// its Secrets, which Compare with Previous compares it with; null where
    /// it keeps none, as after `--history-max` pruned the ones before.
    pub previous: Option<u32>,
    /// Why the shown revision cannot be read; its parts are null then. What
    /// its Secret holds says it until the Secret changes: `helm.not-a-release`,
    /// `helm.truncated`, `helm.too-large`, `answer.undecodable` for a Secret
    /// the server sent in a shape Twigo cannot read, `internal.panic`, and
    /// `helm.revision-gone` for a revision Helm no longer keeps. Any other
    /// code is a request that failed, such as `server.forbidden`,
    /// `server.unavailable` or `connect.refused`, which says nothing of the
    /// revision and stays only while it lasts: Rust asks again after the
    /// hub's backoff and at every relist.
    pub problem: Option<IpcError>,
    /// Described as an object's is: a header whose `printed` are the release
    /// row's cells and whose `created` is the revision's `last_deployed`, then
    /// sections (Diagnostics, Objects, Hooks, Chart, Metadata). With the
    /// overview part.
    pub overview: Option<Overview>,
    /// The rendered NOTES.txt; empty for a chart without one. With the
    /// overview part.
    pub notes: Option<Scrubbed>,
    /// What Helm wrote of the revision, such as `Upgrade complete` or the
    /// error a failed one ended in. With the overview part.
    pub description: Option<Scrubbed>,
    pub values: Option<ReleaseValues>,
    pub manifest: Option<ReleaseManifest>,
    /// Newest first.
    pub history: Option<Vec<RevisionLine>>,
}

/// A text with every value of the revision's Secrets that stands in it as a
/// whole token replaced by `<hidden>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Scrubbed {
    pub text: String,
    /// Something was replaced, which a Reveal of the whole text shows.
    pub hidden: bool,
}

/// A revision's values as JSON text, in the stored order of their keys: keys,
/// booleans and nulls as Helm stored them, every string and number as
/// `<N bytes>`, N the length of its text in UTF-8, a number's as stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ReleaseValues {
    /// What the person set, as `helm get values -o json` prints it: `null`
    /// when they set nothing.
    pub user: String,
    /// The chart's defaults as the release stores them, its subcharts' merged
    /// in at install.
    pub defaults: String,
}

/// A revision's manifest as `helm get manifest` prints it, but each document
/// that holds a Secret written again with its values as their sizes and only
/// its `# Source:` comment kept, and each document Twigo could not read
/// replaced by its `# Source:` line and a line that says so. Hooks are not in
/// it, as they are not in Helm's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ReleaseManifest {
    pub text: String,
    /// In the order they stand.
    pub secrets: Vec<ManifestSecret>,
    /// In the order they stand.
    pub unread: Vec<UnreadDocument>,
}

/// A Secret of a manifest, at the root of its document or inside a List's
/// `items`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ManifestSecret {
    /// The document's index among those Helm's split gives, from 0.
    pub document: u32,
    /// The indexes through `items` from the document to the Secret; empty
    /// for a Secret that is the document.
    pub items: Vec<u32>,
    pub name: String,
    pub namespace: Option<String>,
    /// The line of `text` its document starts at, from 1.
    pub line: u32,
    /// Its keys of `data` and `stringData` with their sizes, a key in both
    /// once, as `stringData`'s, which the server writes over `data`.
    pub entries: Vec<DataEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct UnreadDocument {
    pub document: u32,
    /// The line of `text` it stands at, from 1.
    pub line: u32,
    /// The path its `# Source:` comment names, if it has one.
    pub source: Option<String>,
}

/// A revision as `helm history` prints it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RevisionLine {
    pub revision: u32,
    /// Helm's word: `deployed`, `superseded`, `failed`, `pending-upgrade`…,
    /// the label's until the revision is decoded, then the release's, which
    /// `helm history` prints where the two differ; `unreadable` where what
    /// its Secret holds cannot be read, as a list's row says it, and the
    /// label's while a request for it fails.
    pub status: String,
    /// RFC 3339, `info.last_deployed`; null until decoded.
    pub updated: Option<String>,
    /// `name-version`; null until decoded.
    pub chart: Option<String>,
    pub app_version: Option<String>,
    pub description: Option<Scrubbed>,
    /// The revision a rollback restored, as Helm 4.3 and later record it.
    pub rollback_of: Option<u32>,
    /// Why it cannot be read, as [`ReleaseBatch::problem`] says.
    pub problem: Option<IpcError>,
}

/// Two revisions of a release, for a comparison.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct CompareRevisions {
    pub release: ReleaseRef,
    pub from: u32,
    pub to: u32,
    pub part: ComparedPart,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ComparedPart {
    /// The person's values.
    Values,
    /// The chart's defaults.
    Defaults,
    Manifest,
}

/// The two sides masked as their views are, but that a masked value which
/// differs from its counterpart reads `<N bytes, changed>` on both: values
/// pair by their path, a manifest's Secrets by kind, namespace and name, a
/// Secret whose document writes no namespace in its release's, and a key
/// by the value the server would store, `stringData`'s over `data`'s.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ComparedRevisions {
    pub from: String,
    pub to: String,
}

/// A secret-grade part of a revision, which a Reveal shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HelmPart {
    /// What a path of the values holds, everything under it as JSON text;
    /// an empty path is the whole document.
    Values {
        /// The chart's defaults, not the person's values.
        defaults: bool,
        path: Vec<ValueStep>,
    },
    /// One key of a Secret of the manifest, as [`ManifestSecret`] places it;
    /// its text, or its base64 when it is not UTF-8.
    Secret {
        document: u32,
        items: Vec<u32>,
        key: String,
    },
    /// A document of the manifest that Twigo could not read, whole.
    Document {
        document: u32,
    },
    Notes,
    Description,
}

/// A map's key or a list's index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum ValueStep {
    Key(String),
    Index(u32),
}
