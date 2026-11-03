// Generated from crates/twigo-ipc: TWIGO_UPDATE_TYPESCRIPT=1 cargo test -p twigo-ipc --test typescript

export type Ack = { id: SubscriptionId, seq: number, };

export type AnsiColor = "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white" | "brightBlack" | "brightRed" | "brightGreen" | "brightYellow" | "brightBlue" | "brightMagenta" | "brightCyan" | "brightWhite";

export type Block = { "type": "fields", fields: Array<Field>, } | { "type": "conditions", conditions: Array<Condition>, } | { "type": "data", entries: Array<DataEntry>, 
/**
 * Whether [`GetValues`] sends their values: a ConfigMap's text
 * values, never a Secret's.
 */
readable: boolean, } | { "type": "tree", nodes: Array<TreeNode>, } | { "type": "events" } & EventList | { "type": "diagnostics", findings: Array<Finding>, } | { "type": "containers", containers: Array<Container>, } | { "type": "table", columns: Array<string>, rows: Array<Array<Value>>, } | { "type": "list" } & EmbeddedList;

export type Bucket = { 
/**
 * Every line in the span, warnings and errors included.
 */
lines: number, warnings: number, errors: number, };

export type Cell = null | boolean | number | number | string;

/**
 * What the API server says about itself, from `/version`.
 */
export type ClusterVersion = { 
/**
 * Such as `v1.33.4`.
 */
gitVersion: string, };

export type Column = { name: string, kind: ColumnKind, 
/**
 * 0 is shown by default; higher only in the wide view.
 */
priority: number, };

export type ColumnKind = "string" | "integer" | "number" | "boolean" | "date" | "age" | "other";

export type ColumnValues = { 
/**
 * A column name from [`ListBatch::columns`].
 */
column: string, values: Array<string>, };

export type Condition = { type: string, status: string, 
/**
 * Whether this status is good news, as Ready=True is and
 * MemoryPressure=True is not.
 */
tone: Tone, reason: string | null, message: string | null, 
/**
 * RFC 3339.
 */
lastTransition: string | null, 
/**
 * RFC 3339, when its reporter last confirmed it, as a node's kubelet
 * does.
 */
lastHeartbeat: string | null, };

export type Container = { name: string, role: ContainerRole, image: string, 
/**
 * None in a pod template, and until the kubelet reports it.
 */
state: ContainerState | null, 
/**
 * As kubectl prints them: `8080/TCP (http)`.
 */
ports: Array<string>, 
/**
 * What its card shows: its state's times, how it last ended, its
 * resources.
 */
fields: Array<Field>, 
/**
 * What else kubectl describe prints of it, folded: the last
 * termination's message, command, probes, security, image and
 * container IDs.
 */
details: Array<Field>, 
/**
 * Each variable by name, then each source of many as "From".
 */
env: Array<Field>, 
/**
 * By the path it is mounted at.
 */
mounts: Array<Field>, };

export type ContainerRole = "init" | "sidecar" | "regular" | "ephemeral";

export type ContainerState = { 
/**
 * "Running", "Waiting · CrashLoopBackOff", "Terminated · Completed".
 */
text: string, tone: Tone, ready: boolean, restarts: number, };

/**
 * Which containers of each pod a session follows.
 */
export type Containers = { "type": "default" } | { "type": "named", name: string, } | { "type": "all" };

/**
 * A context the catalog lists.
 */
export type Context = { name: string, 
/**
 * From the `twigo` extension of the kubeconfig context; none by default.
 */
color: ContextColor | null, 
/**
 * The kubeconfig file that defines it, as a person names it:
 * `~/.kube/config`.
 */
source: string, 
/**
 * The URL of the cluster it reaches, only its scheme, host and port:
 * `https://10.0.0.1:6443`. None when the kubeconfig names no server
 * that parses.
 */
server: string | null, };

/**
 * How a context gets its credentials.
 */
export type ContextAuth = { "state": "none" } | { "state": "invalid", message: string, } | { "state": "untrusted", plugin: ExecPlugin, } | { "state": "plugin", plugin: ExecPlugin, status: PluginStatus, };

export type ContextColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple";

export type DataEntry = { key: string, bytes: number, 
/**
 * From `binaryData`, or a Secret value that is not UTF-8.
 */
binary: boolean, };

/**
 * A context's resources as discovery last answered, or why it did not.
 * `cluster` names the cluster the context reaches: its URL, its
 * `tls-server-name` and the CAs it is trusted with.
 */
export type Discovered = { "state": "pending", cluster: string, } | { "state": "ready", cluster: string, resources: Array<Resource>, } | { "state": "failed", error: IpcError, };

export type DownloadLogs = { id: SubscriptionId, 
/**
 * The lines the view keeps, else every line the buffer holds.
 */
filtered: boolean, };

/**
 * A list of objects of one resource, run as any list is: the webview
 * subscribes with it in the object's space.
 */
export type EmbeddedList = { gvr: Gvr, 
/**
 * The kind of its objects, which opening a row names.
 */
kind: string, namespaced: boolean, 
/**
 * None for every namespace, as a node's pods are.
 */
namespace: string | null, fieldSelector: string | null, 
/**
 * As in [`crate::ListQuery`].
 */
owners: Array<string> | null, };

export type EnvVar = { name: string, value: string, };

export type ErrorKind = "invalidInput" | "notFound" | "conflict" | "forbidden" | "unauthorized" | "timeout" | "unavailable" | "internal";

/**
 * An object's events, newest first.
 */
export type EventList = { events: Array<ObjectEvent>, 
/**
 * Why they cannot be listed, as when the person may not list events;
 * None while they are listed or still coming.
 */
unavailable: string | null, };

/**
 * An exec credential plugin as the kubeconfig names it (ARCHITECTURE 6.2).
 */
export type ExecPlugin = { command: string, args: Array<string>, env: Array<EnvVar>, 
/**
 * Identifies what the person trusts: the command, its arguments and
 * its environment.
 */
digest: string, 
/**
 * It may open a browser or print a device code, so it runs only while
 * a Twigo window has the focus.
 */
signsIn: boolean, };

/**
 * The plugins the kubeconfigs name that the person has not trusted, for
 * the review on the first start.
 */
export type ExecReview = { 
/**
 * The person has answered a review before, so a new plugin asks only
 * when it is about to run.
 */
reviewed: boolean, plugins: Array<ReviewedPlugin>, };

export type Field = { label: string, value: Value, };

export type Finding = { 
/**
 * Danger for what keeps the object from working, warning for what
 * may.
 */
tone: Tone, 
/**
 * What is wrong: "Container api keeps crashing".
 */
title: string, 
/**
 * Why, as a sentence whose times are read when shown.
 */
detail: Array<Span>, 
/**
 * What the component that saw it said, shown as it said it: a
 * termination message, a waiting reason's message, an event's note.
 */
message: string | null, };

/**
 * Asks for the values of a ConfigMap's keys, which its Overview lists with
 * their sizes only.
 */
export type GetValues = { id: SubscriptionId, keys: Array<string>, };

/**
 * The rows grouped by the text of a column: the groups in the natural
 * order of their values, runs of ASCII digits by their value and ASCII
 * letters folded, the empty value last, and the rows of each group in
 * the query's sort.
 */
export type Grouping = { 
/**
 * A column name from [`ListBatch::columns`].
 */
column: string, 
/**
 * The values of the groups the window skips. Their rows still count
 * in `total`, in `counts` and in their group's `rows`; a value no
 * group has does nothing.
 */
collapsed: Array<string>, };

export type Gvr = { 
/**
 * Empty for the core group.
 */
group: string, version: string, resource: string, };

/**
 * The view's lines over time, its range aside, in equal spans from `from`
 * to `to`.
 */
export type Histogram = { 
/**
 * RFC 3339.
 */
from: string, 
/**
 * RFC 3339.
 */
to: string, buckets: Array<Bucket>, };

/**
 * The error every command returns. The webview branches on `kind`; `message`
 * is for people.
 */
export type IpcError = { kind: ErrorKind, message: string, };

/**
 * The characters one key types; empty where it types none.
 */
export type KeyMapping = { value: string, withShift: string, 
/**
 * With Option on macOS.
 */
withAltGr: string, withShiftAltGr: string, };

/**
 * What each key of the active keyboard layout types (ARCHITECTURE 5.2).
 * WebKit has no Keyboard Map API, so the keybinding service learns the
 * layout from Rust.
 */
export type KeyboardLayout = { 
/**
 * The OS's name for the layout: the input source ID on macOS, such as
 * `com.apple.keylayout.Ukrainian`, the XKB layout name on Linux, such as
 * `Ukrainian`, and the keyboard layout handle (HKL) in hex on Windows.
 */
id: string, 
/**
 * The writing-system keys, by `KeyboardEvent.code` (`KeyA`, `Slash`).
 */
keys: { [key in string]: KeyMapping }, };

export type Label = { key: string, value: string, };

export type Level = "trace" | "debug" | "info" | "warn" | "error";

export type LevelFilter = "all" | "warn" | "error";

/**
 * One flush of a subscription. Rust sends the next batch only after the
 * webview acknowledged this one's `seq`, and coalesces changes meanwhile.
 */
export type ListBatch = { seq: number, 
/**
 * Rows matching the query, in or out of the window, those of collapsed
 * groups included.
 */
total: number, 
/**
 * Present in the first batch and whenever the server's columns change.
 */
columns: Array<Column> | null, 
/**
 * Present when the window's rows or their order changed. The view keeps
 * exactly these rows.
 */
window: Window | null, 
/**
 * Rows that entered the window or changed.
 */
upserts: Array<Row>, status: ViewState, 
/**
 * With `count_by`: the matching rows per value of that column, present
 * in the first batch and whenever a count changes.
 */
counts: Array<ValueCount> | null, 
/**
 * With `group_by`: the groups that hold matching rows, in group order,
 * present once the list has the column and whenever a group appears,
 * disappears or moves, or its rows or counts change. Empty once the
 * list no longer has the column.
 */
groups: Array<RowGroup> | null, };

export type ListQuery = { space: string, gvr: Gvr, 
/**
 * Whether the resource lives in namespaces, as discovery says: one
 * that does not ignores `namespaces`, and one that does gets a
 * Namespace column unless `namespaces` names one.
 */
namespaced: boolean, 
/**
 * Empty for every namespace the space covers.
 */
namespaces: Array<string>, labelSelector: string | null, 
/**
 * Sent to the server, as `spec.nodeName=kind-control-plane` picks a
 * node's pods.
 */
fieldSelector: string | null, 
/**
 * Keeps the rows whose controller is one of the objects with these
 * uids, as a workload's pods are its ReplicaSets'; empty keeps none.
 */
owners: Array<string> | null, 
/**
 * A substring of a shown cell in any case of ASCII letters, `!` before
 * it to keep the rows without one, or a regex between slashes, also in
 * any case: `/^web-\d+/`, negated as `!/…/`.
 */
text: string | null, 
/**
 * The user's column choices by name, which the text filter follows
 * besides Name: true shows a column, false hides it, and the rest show
 * by priority 0. The server resolves them against its own columns, so
 * a choice for a column the list lacks, such as Namespace under one
 * namespace, does nothing. Null shows the columns of priority 0.
 */
columns: { [key in string]: boolean } | null, 
/**
 * Null, or a column the list lacks, sorts by Name.
 */
sort: Sort | null, 
/**
 * A column to count the matching rows by, such as a pod's Status; one
 * the list lacks counts nothing.
 */
countBy: string | null, 
/**
 * A column to group the matching rows by; one the list lacks groups
 * nothing.
 */
groupBy: Grouping | null, 
/**
 * Keeps the rows whose column holds one of the values, read as text.
 * The counts of `count_by` come before it, so the values it drops keep
 * theirs; a column the list lacks keeps every row.
 */
values: ColumnValues | null, };

/**
 * One flush of a session. Rust sends the next only after the webview
 * acknowledged this one's `seq`, and coalesces changes meanwhile.
 */
export type LogBatch = { seq: number, 
/**
 * The target's: whether its pods are listed, may be read, or are gone.
 */
status: ViewState, 
/**
 * Present in the first batch and whenever a pod, a container or a
 * stream's state changes.
 */
pods: Array<LogPod> | null, 
/**
 * Entries the view keeps, in or out of the window.
 */
total: number, 
/**
 * Present when the window's entries changed; the view keeps exactly
 * these.
 */
window: LogEntries | null, 
/**
 * Present when the search, or what it matches, changed; empty without
 * a search.
 */
matches: LogMatches | null, 
/**
 * Present when it changed.
 */
histogram: Histogram | null, 
/**
 * Lines the buffer's bound dropped since the session opened (decision
 * 24).
 */
dropped: number, };

export type LogContainer = { name: string, stream: StreamState, };

export type LogEntries = { 
/**
 * An index into the view's entries, as in [`LogWindow::Range`].
 */
start: number, entries: Array<LogEntry>, };

/**
 * Every entry has an `id`, which stays its own while the buffer holds it,
 * so the webview keeps its place as entries enter and leave before it.
 */
export type LogEntry = { "type": "line", id: number, pod: string, container: string, 
/**
 * RFC 3339 with nanoseconds, as the kubelet stamps the line.
 */
time: string, level: Level | null, 
/**
 * Without its ANSI escapes.
 */
text: string, 
/**
 * What its ANSI escapes styled.
 */
styles: Array<TextStyle>, 
/**
 * The search's matches.
 */
marks: Array<TextRange>, } | { "type": "ended", id: number, pod: string, container: string, 
/**
 * RFC 3339.
 */
time: string, exitCode: number | null, reason: string | null, 
/**
 * RFC 3339, when the kubelet starts it again, in a crash loop's
 * back-off.
 */
restarting: string | null, } | { "type": "joined", id: number, pod: string, 
/**
 * RFC 3339.
 */
time: string, } | { "type": "left", id: number, pod: string, 
/**
 * RFC 3339.
 */
time: string, } | { "type": "dropped", id: number, count: number, };

export type LogMatches = { 
/**
 * Every match in the view.
 */
count: number, 
/**
 * The view's index of the entry of each match, in order, so an entry
 * with two matches comes twice; the first 10,000 matches.
 */
entries: Array<number>, };

export type LogPod = { name: string, 
/**
 * Where the generated part of its name starts, as a row's
 * [`generated`](crate::Row::generated).
 */
generated: number | null, 
/**
 * As the pod list's Status column has it: Running, CrashLoopBackOff.
 */
status: string, tone: Tone, containers: Array<LogContainer>, };

/**
 * What a session reads from the cluster; a change reopens its streams.
 */
export type LogSource = { containers: Containers, 
/**
 * The pods to follow, by name; null follows the target's pods, new
 * ones included, as long as the tab's ten streams last (decision 23).
 */
pods: Array<string> | null, since: Since, 
/**
 * Each container's previous instance, the one that ended, read to its
 * end rather than followed.
 */
previous: boolean, };

/**
 * What a logs tab follows: a pod, or a Deployment, ReplicaSet,
 * StatefulSet, DaemonSet, Job or CronJob, whose pods it merges and whose
 * new pods join it, as a rollout's do.
 */
export type LogTarget = { space: string, gvr: Gvr, namespace: string, name: string, };

/**
 * How a session shows its buffer; a change filters it again in Rust and
 * reopens nothing.
 */
export type LogView = { level: LevelFilter, 
/**
 * Keeps the lines whose text matches, in the list filter's syntax: a
 * substring in any case of ASCII letters, `!` before it to keep the
 * lines without one, or a regex between slashes, also in any case,
 * negated as `!/…/`.
 */
filter: string | null, 
/**
 * Marks the matches in the text of the lines the view keeps: a
 * substring in any case of ASCII letters, or a regex between slashes,
 * also in any case.
 */
search: string | null, 
/**
 * Keeps the lines from `from` to `to`, picked on the histogram.
 */
range: TimeRange | null, };

/**
 * The lines of the view a window reads, markers included.
 */
export type LogWindow = { "type": "tail", count: number, } | { "type": "range", start: number, end: number, };

/**
 * One flush of an open object. Rust sends the next only after the webview
 * acknowledged this one's `seq`, and coalesces changes meanwhile.
 */
export type ObjectBatch = { seq: number, status: ViewState, 
/**
 * False until the object is listed, and once it is deleted.
 */
exists: boolean, 
/**
 * Present when it changed, while the overview part is shown.
 */
overview: Overview | null, 
/**
 * The object's JSON with managedFields dropped and a Secret's values
 * replaced by their sizes; present when it changed, while the manifest
 * part is shown.
 */
manifest: string | null, 
/**
 * Present when they changed, while the events part is shown.
 */
events: EventList | null, 
/**
 * Present when it changed, while the related part is shown.
 */
related: Related | null, };

export type ObjectEvent = { 
/**
 * Normal or Warning.
 */
type: string, reason: string, message: string, 
/**
 * The component that reported it.
 */
source: string, 
/**
 * How often it happened; 1 for a single event.
 */
count: number, 
/**
 * RFC 3339.
 */
first: string | null, 
/**
 * RFC 3339.
 */
last: string | null, 
/**
 * The part of the object it is about, such as `spec.containers{app}`.
 */
fieldPath: string | null, };

/**
 * What the views of an open object show; Rust follows only these.
 */
export type ObjectParts = { 
/**
 * The Overview document, its events included.
 */
overview: boolean, 
/**
 * The object as the YAML tab shows it.
 */
manifest: boolean, 
/**
 * The object's events, for the Events tab.
 */
events: boolean, 
/**
 * Its owners and the objects it owns.
 */
related: boolean, };

/**
 * Names one object of a space.
 */
export type ObjectQuery = { space: string, gvr: Gvr, 
/**
 * Whether the resource lives in namespaces, as discovery says.
 */
namespaced: boolean, 
/**
 * None for a cluster-scoped object.
 */
namespace: string | null, name: string, };

/**
 * An object a link points at, by kind: the webview finds its resource
 * through discovery.
 */
export type ObjectRef = { 
/**
 * Empty for the core group.
 */
group: string, version: string, kind: string, 
/**
 * The namespace of the object that points at it, which the webview
 * drops when discovery says the kind is cluster-scoped.
 */
namespace: string | null, name: string, };

/**
 * Rust sends nothing of the lines until the webview sets a window.
 */
export type OpenLogs = { target: LogTarget, source: LogSource, view: LogView, };

export type OpenObject = { object: ObjectQuery, parts: ObjectParts, };

/**
 * An object described for people: sections in their order, each a list of
 * blocks from a closed set (ARCHITECTURE 4.3).
 */
export type Overview = { sections: Array<Section>, };

export type PluginStatus = { "state": "idle" } | { "state": "waiting" } | { "state": "running", 
/**
 * When the run started, RFC 3339.
 */
since: string, output: string, } | { "state": "ready", 
/**
 * RFC 3339; none when the credential lasts until the cluster
 * rejects it.
 */
expires: string | null, } | { "state": "failed", error: string, output: string, 
/**
 * The kubeconfig's `installHint`, when the command was not found.
 */
installHint: string | null, };

export type Related = { owners: Array<RelatedObject>, owned: Array<RelatedObject>, 
/**
 * Why some owned objects cannot be listed.
 */
unavailable: string | null, };

export type RelatedObject = { target: ObjectRef, 
/**
 * The owner reference that ties them is the controller's.
 */
controller: boolean, };

/**
 * A resource the space's clusters serve, from discovery: what the explorer
 * lists and what `:` in quick access resolves names against (ARCHITECTURE 4.5).
 */
export type Resource = { gvr: Gvr, kind: string, singular: string, shortNames: Array<string>, namespaced: boolean, };

export type ReviewedPlugin = { plugin: ExecPlugin, 
/**
 * The contexts that use it.
 */
contexts: Array<string>, };

export type Row = { id: RowId, 
/**
 * RFC 3339; the webview renders Age columns from it.
 */
created: string | null, 
/**
 * Where the generated part of the object's name starts, in UTF-16
 * units: after its `metadata.generateName`, or at a pod's
 * `pod-template-hash` within it, so `api-7f9c8d6b5-x2kq9` reads `api-`
 * before what was generated. Null for a name the API server did not
 * generate.
 */
generated: number | null, 
/**
 * One per column; null in Age columns.
 */
cells: Array<Cell>, };

export type RowGroup = { 
/**
 * The column's text; empty for the rows that have none.
 */
value: string, 
/**
 * The group's matching rows, collapsed or not.
 */
rows: number, 
/**
 * With `count_by`: the group's rows per value of that column, counted
 * before `values` drops any and ordered as the list's counts are,
 * largest first; empty without it.
 */
counts: Array<ValueCount>, };

/**
 * `context/namespace/name`, or `context/name` for cluster-scoped objects.
 */
export type RowId = string;

export type Section = { 
/**
 * Stable, such as `core.metadata`; folding is kept by it.
 */
id: string, title: string, blocks: Array<Block>, };

export type SetLogSource = { id: SubscriptionId, source: LogSource, };

export type SetLogView = { id: SubscriptionId, view: LogView, };

export type SetLogWindow = { id: SubscriptionId, window: LogWindow, };

export type SetParts = { id: SubscriptionId, parts: ObjectParts, };

/**
 * `start` and `end` index the rows a window reads: every matching row,
 * or with `group_by` those of the groups not collapsed, in group order.
 */
export type SetWindow = { id: SubscriptionId, start: number, 
/**
 * Exclusive.
 */
end: number, };

/**
 * Where the login shell's environment stands (ARCHITECTURE 6.1).
 */
export type ShellEnvironment = { "state": "resolving" } | { "state": "resolved" } | { "state": "failed", 
/**
 * The shell's path, such as `/bin/zsh`.
 */
shell: string, 
/**
 * What went wrong, worded to follow the shell's path: `did not answer in 10 s`.
 */
reason: string, 
/**
 * The end of what the shell printed, the environment left out.
 */
output: string, };

/**
 * Where each container's lines start.
 */
export type Since = { "type": "lines", lines: number, } | { "type": "seconds", seconds: number, } | { "type": "start" };

export type Sort = { 
/**
 * A column name from [`ListBatch::columns`].
 */
column: string, descending: boolean, };

/**
 * A workbench space: one context or a group of them (ARCHITECTURE 4.2).
 */
export type Space = { id: string, name: string, 
/**
 * The names of its contexts; the catalog's `Context` says the rest,
 * as long as a source lists it.
 */
contexts: Array<string>, };

export type Span = { "type": "text", text: string, } | { "type": "ago", at: string, } | { "type": "until", at: string, };

/**
 * UI state that is not settings (ARCHITECTURE 4.8), such as a space's
 * layout or the command history. The value is JSON that the webview writes
 * and reads back; the core checks only that it is JSON.
 */
export type StateEntry = { 
/**
 * The space it belongs to; none for the whole app.
 */
space: string | null, key: string, value: string, };

/**
 * Every stored value, read once as the webview starts.
 */
export type StateSnapshot = { app: { [key in string]: string }, 
/**
 * By space id.
 */
spaces: { [key in string]: { [key in string]: string } }, };

export type StreamState = { "state": "off" } | { "state": "overLimit" } | { "state": "queued" } | { "state": "connecting" } | { "state": "following" } | { "state": "ended" } | { "state": "waiting", reason: string | null, } | { "state": "error", error: IpcError, };

export type SubscriptionId = number;

/**
 * Indexes a line's text in UTF-16 units; `end` is exclusive.
 */
export type TextRange = { start: number, end: number, };

/**
 * A run of text an ANSI escape styled; 256 and true colours come as the
 * nearest of the sixteen.
 */
export type TextStyle = { range: TextRange, fg: AnsiColor | null, bg: AnsiColor | null, bold: boolean, dim: boolean, italic: boolean, underline: boolean, };

/**
 * RFC 3339; `to` is exclusive.
 */
export type TimeRange = { from: string, to: string, };

export type Tone = "neutral" | "success" | "warning" | "danger";

export type TreeNode = { 
/**
 * A map's key, or a list item's name, else its index.
 */
key: string, 
/**
 * The key as people read it: a field's name in words, such as
 * "Termination grace period seconds"; other keys as they are.
 */
label: string, value: TreeValue, };

export type TreeValue = { "type": "scalar", text: string, } | { "type": "map", entries: Array<TreeNode>, } | { "type": "list", items: Array<TreeNode>, };

export type Value = { "type": "text", text: string, } | { "type": "time", at: string, } | { "type": "link", target: ObjectRef, text: string, } | { "type": "labels", labels: Array<Label>, } | { "type": "list", items: Array<Value>, } | { "type": "code", text: string, } | { "type": "toned", text: string, tone: Tone, };

export type ValueCount = { value: string, count: number, };

/**
 * The state of the upstream behind a subscription (ARCHITECTURE 3.7).
 */
export type ViewState = { "state": "queued" } | { "state": "connecting" } | { "state": "syncing", loaded: number, } | { "state": "ready" } | { "state": "relisting" } | { "state": "stale" } | { "state": "forbidden", verb: string, resource: string, } | { "state": "unauthorized" } | { "state": "error", error: IpcError, };

export type Window = { 
/**
 * An index into the rows the window reads, as in [`SetWindow`].
 */
start: number, ids: Array<RowId>, };

export type Commands = {
  spaces_list: { request: null; response: Array<Space>; message: null };
  contexts_watch: { request: null; response: Array<Context>; message: Array<Context> };
  space_open: { request: string; response: Space; message: null };
  resources_watch: { request: string; response: null; message: Discovered };
  namespaces_list: { request: string; response: Array<string>; message: null };
  cluster_version: { request: string; response: ClusterVersion; message: null };
  list_subscribe: { request: ListQuery; response: SubscriptionId; message: ListBatch };
  list_set_window: { request: SetWindow; response: null; message: null };
  list_ack: { request: Ack; response: null; message: null };
  list_unsubscribe: { request: SubscriptionId; response: null; message: null };
  object_open: { request: OpenObject; response: SubscriptionId; message: ObjectBatch };
  object_set_parts: { request: SetParts; response: null; message: null };
  object_ack: { request: Ack; response: null; message: null };
  object_values: { request: GetValues; response: Array<string | null>; message: null };
  object_close: { request: SubscriptionId; response: null; message: null };
  logs_open: { request: OpenLogs; response: SubscriptionId; message: LogBatch };
  logs_set_source: { request: SetLogSource; response: null; message: null };
  logs_set_view: { request: SetLogView; response: null; message: null };
  logs_set_window: { request: SetLogWindow; response: null; message: null };
  logs_ack: { request: Ack; response: null; message: null };
  logs_download: { request: DownloadLogs; response: string | null; message: null };
  logs_close: { request: SubscriptionId; response: null; message: null };
  keyboard_layout_watch: { request: null; response: KeyboardLayout; message: KeyboardLayout };
  state_load: { request: null; response: StateSnapshot; message: null };
  state_set: { request: Array<StateEntry>; response: null; message: null };
  shell_environment_watch: { request: null; response: ShellEnvironment; message: ShellEnvironment };
  shell_environment_retry: { request: null; response: null; message: null };
  context_auth_watch: { request: string; response: ContextAuth; message: ContextAuth };
  context_sign_in: { request: string; response: null; message: null };
  context_sign_in_cancel: { request: string; response: null; message: null };
  exec_review: { request: null; response: ExecReview; message: null };
  exec_trust: { request: Array<string>; response: null; message: null };
  url_open: { request: string; response: null; message: null };
};
