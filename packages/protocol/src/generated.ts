// Generated from crates/twigo-ipc: TWIGO_UPDATE_TYPESCRIPT=1 cargo test -p twigo-ipc --test typescript

/**
 * One thing RBAC may allow: `patch` on `deployments/scale` of `apps`.
 */
export type Access = { verb: string, 
/**
 * Empty for the core group.
 */
group: string, resource: string, subresource: string | null, 
/**
 * The one object it is for, which a rule that lists `resourceNames`
 * needs; none for the resource as a whole.
 */
name: string | null, };

/**
 * What the person asks whether they may do in a space, as RBAC names it,
 * in one namespace or, with none, in all of them and for cluster-scoped
 * resources.
 */
export type AccessQuery = { space: string, namespace: string | null, checks: Array<Access>, };

export type Ack = { id: SubscriptionId, seq: number, };

/**
 * Objects that one thing happens to.
 */
export type Affected = { 
/**
 * What happens to them: `With it go`, `Evicts`.
 */
title: string, objects: Array<ObjectRef>, };

export type AnsiColor = "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white" | "brightBlack" | "brightRed" | "brightGreen" | "brightYellow" | "brightBlue" | "brightMagenta" | "brightCyan" | "brightWhite";

/**
 * A field another manager owns that an apply would change.
 */
export type ApplyConflict = { 
/**
 * As the server names it: `.spec.replicas`.
 */
path: string, manager: string, };

/**
 * What a dry-run found; a closed set, so the webview cannot miss a case.
 */
export type ApplyPreviewed = { "state": "unchanged", 
/**
 * What the edit said that Twigo leaves out: `status`, the
 * server's metadata.
 */
ignored: Array<string>, } | { "state": "ready", id: PreviewId, 
/**
 * Null for a manifest of a new object.
 */
live: unknown, result: unknown, warnings: Array<string>, 
/**
 * What goes by a merge patch: a separate step after a
 * server-side apply, or part of the one patch.
 */
removals: Array<string>, ignored: Array<string>, strategy: ApplyStrategy, } | { "state": "conflicts", conflicts: Array<ApplyConflict>, } | { "state": "stale", message: string, 
/**
 * Whether "Keep mine" answers it. It does not for a list sent whole,
 * which keeping the edit would send again, reverting the other
 * writer's change; only a reload answers that.
 */
keepable: boolean, } | { "state": "immutable", message: string, recreate: PreviewId | null, };

/**
 * An edit to preview, parsed by the webview's YAML parser, so there is one
 * YAML dialect.
 */
export type ApplyRequest = { space: string, 
/**
 * The object it edits; none for a new manifest, whose object is its
 * whole configuration and whose resource comes from discovery.
 */
opened: OpenedEdit | null, 
/**
 * The object as the person left it.
 */
edited: unknown, 
/**
 * Answer conflicts by taking the fields.
 */
force: boolean, 
/**
 * The conflicting paths the person gave up, as [`ApplyConflict`] names
 * them, which leave the configuration.
 */
drop: Array<string>, };

/**
 * How an edit that can go is sent.
 */
export type ApplyStrategy = "serverSideApply" | "mergePatch";

export type Block = { "type": "fields", fields: Array<Field>, } | { "type": "conditions", conditions: Array<Condition>, } | { "type": "data", entries: Array<DataEntry>, 
/**
 * Whether [`GetValues`] sends their values: a ConfigMap's text
 * values, never a Secret's.
 */
readable: boolean, } | { "type": "tree", nodes: Array<TreeNode>, } | { "type": "events" } & EventList | { "type": "diagnostics", findings: Array<Finding>, } | { "type": "containers", containers: Array<Container>, } | { "type": "table", columns: Array<string>, rows: Array<Array<Value>>, } | { "type": "list" } & EmbeddedList;

/**
 * Why the gate stopped it.
 */
export type BlockReason = "mode" | "noGrant" | "noApproval";

/**
 * A request the gate stopped before it left the process.
 */
export type Blocked = { context: string, mode: Mode, source: ModeSource, class: RequestClass, reason: BlockReason, 
/**
 * What it asked for, as RBAC names it: `create`, `get`, `proxy`.
 */
verb: string, 
/**
 * What it asked that of: `pods/web-1/exec in default`, or a path.
 */
target: string, };

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
server: string | null, 
/**
 * Its mode, where the mode comes from and what it is marked as.
 */
access: ContextAccess, };

/**
 * What a context lets through now, and why.
 */
export type ContextAccess = { 
/**
 * In force now: `guarded` while a `read-only` context is unlocked.
 */
mode: Mode, 
/**
 * Where the mode comes from, an unlock aside.
 */
source: ModeSource, environment: Environment | null, 
/**
 * When an unlock ends and the context relocks, in milliseconds since
 * the epoch.
 */
unlockedUntil: number | null, };

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

/**
 * What a context is marked as, by a person or its kubeconfig; a context
 * nobody marked has none. It sets the default mode and colour.
 */
export type Environment = "production" | "staging" | "development" | "local";

export type ErrorKind = "invalidInput" | "notFound" | "conflict" | "forbidden" | "unauthorized" | "permissions" | "timeout" | "unavailable" | "internal";

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

/**
 * Runs a plan, with what its friction asks for.
 */
export type Execute = { plan: PlanId, 
/**
 * What the person typed, for a `typed` friction.
 */
typed: string | null, };

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
message: string | null, 
/**
 * A container's finding's logs, for its Previous logs and the last
 * line its previous instance wrote.
 */
logs: FindingLogs | null, };

export type FindingLogs = { container: string, 
/**
 * It has a previous instance, which a logs tab reads with `previous`.
 */
previous: boolean, 
/**
 * The last line of its instance that ended last, without its escapes,
 * once it has a previous one: null until Twigo has read it, or when it
 * wrote none.
 */
lastLine: string | null, };

/**
 * What a person goes through before a plan runs, by what it risks and the
 * context's mode (ARCHITECTURE 6.4).
 */
export type Friction = { "kind": "atOnce" } | { "kind": "countdown", seconds: number, } | { "kind": "confirm" } | { "kind": "typed", text: string, };

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
 * to `to`; no spans while the buffer holds no line.
 */
export type Histogram = { 
/**
 * RFC 3339, or empty without spans.
 */
from: string, 
/**
 * RFC 3339, or empty without spans.
 */
to: string, buckets: Array<Bucket>, };

/**
 * The error every command returns. The webview branches on `kind`; `message`
 * is for people.
 */
export type IpcError = { kind: ErrorKind, message: string, 
/**
 * With `permissions`: the mode and its source, when the gate stopped a
 * request.
 */
blocked?: Blocked, };

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
 * The entry a [`LogWindow::Around`] was asked around, and where it
 * stands: at its index while the view keeps it, else where it would
 * stand if the view kept it.
 */
export type LogAround = { id: number, 
/**
 * An index into the view's entries, as [`LogEntries::start`].
 */
index: number, };

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
 * Entries the buffer's bound dropped since the session opened
 * (ARCHITECTURE 4.6).
 */
dropped: number, 
/**
 * Entries the view has kept as they came since the session opened or
 * its source or view last changed, a count that only grows meanwhile:
 * a paused list counts the new ones by it, since `total` stops growing
 * at the bound.
 */
arrived: number, 
/**
 * The source and view changes the session has applied since it
 * opened, a no-op among them, so the webview knows which of those it
 * sent `arrived` and the window already reflect.
 */
changes: number, };

export type LogContainer = { name: string, stream: StreamState, };

export type LogEntries = { 
/**
 * An index into the view's entries, as in [`LogWindow::Range`].
 */
start: number, entries: Array<LogEntry>, 
/**
 * Where the entry of a [`LogWindow::Around`] stands, so the webview
 * tells the answer to the window it asked for from an earlier one,
 * and places an entry the view no longer keeps; absent for the other
 * windows.
 */
around: LogAround | null, };

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
 * back-off. The kubelet tells it only once the back-off's waiting
 * state shows, so a later batch fills it in under the same id.
 */
restarting: string | null, } | { "type": "joined", id: number, pod: string, 
/**
 * RFC 3339.
 */
time: string, 
/**
 * What controls the pod, by its controller owner reference: a
 * Deployment's pod's ReplicaSet, a CronJob's pod's Job.
 */
owner: ObjectRef | null, } | { "type": "left", id: number, pod: string, 
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
 * The id of each match's entry, in the view's order, so an entry with
 * two matches comes twice: the last 10,000 matches, since a search
 * steps back from the newest. Ids, unlike indices, stay as entries
 * enter and leave, so the webview finds a match outside its window
 * by asking for the window around it.
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
 * ones included, as long as the tab's ten streams last (ARCHITECTURE 4.6).
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
export type LogWindow = { "type": "tail", count: number, } | { "type": "range", start: number, end: number, } | { "type": "around", id: number, before: number, after: number, };

/**
 * How much a context lets through (ARCHITECTURE 6.4). Rust owns it, and the
 * webview only shows it.
 */
export type Mode = "read-write" | "guarded" | "read-only";

/**
 * Where a context's mode comes from, highest first.
 */
export type ModeSource = { "kind": "policyFile", file: string, pattern: string | null, } | { "kind": "unlisted" } | { "kind": "moved" } | { "kind": "user" } | { "kind": "kubeconfig" } | { "kind": "provider" } | { "kind": "environment", environment: Environment, } | { "kind": "default" };

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
 * Starts the session a plan's run answered with.
 */
export type OpenShell = { id: SubscriptionId, cols: number, rows: number, };

/**
 * The object as it was opened, which an edit is measured against. Its
 * `lock` is apart from `base`: "Keep mine" after a change on the server
 * diffs against the old base and locks to the new version, since diffing
 * against the new live object would revert the other writer's change.
 */
export type OpenedEdit = { target: ResourceRef, 
/**
 * The object as the webview received it: without managedFields, a
 * Secret's values masked.
 */
base: unknown, 
/**
 * The `resourceVersion` to hold the apply to.
 */
lock: string, 
/**
 * The object as it stood at `lock`, when that is not `base`: "Keep
 * mine" locks to a newer version than the one edited, and this is what
 * says a later status write changed nothing.
 */
locked?: unknown, };

/**
 * How a running plan goes, over its channel; every kind but `running` is
 * the last.
 */
export type OperationEvent = { "state": "running", text: string, } | { "state": "done", text: string, undoUntil: number | null, } | { "state": "stopped", text: string, } | { "state": "revealed", value: string, binary: boolean, } | { "state": "session", id: SubscriptionId, } | { "state": "failed", error: IpcError, };

/**
 * An object described for people: sections in their order, each a list of
 * blocks from a closed set (ARCHITECTURE 4.3).
 */
export type Overview = { sections: Array<Section>, };

/**
 * What a command will do, for the person to confirm. It runs only by its
 * id, once, on the cluster it was planned for.
 */
export type Plan = { id: PlanId, context: string, environment: Environment | null, mode: Mode, friction: Friction, 
/**
 * The question a dialog asks, naming the cluster: `Delete pod web-1
 * from kind-a?`
 */
question: string, 
/**
 * What the confirming button says: `Delete pod`.
 */
confirm: string, 
/**
 * Whether it takes something away for good, which its button shows.
 */
destructive: boolean, 
/**
 * What follows, a sentence each.
 */
consequences: Array<string>, 
/**
 * The exact objects it acts on and those that follow, by what happens
 * to them.
 */
affected: Array<Affected>, 
/**
 * The kubectl command that does the same.
 */
kubectl: string, 
/**
 * What a toast or the status bar says while it counts down or runs:
 * `Deleting pod web-1`.
 */
doing: string, };

export type PlanId = number;

/**
 * What a person asks a command to do.
 */
export type PlanRequest = { "action": "delete", space: string, targets: Array<ResourceRef>, } | { "action": "scale", space: string, target: ResourceRef, replicas: number, } | { "action": "restart", space: string, target: ResourceRef, } | { "action": "cordon", space: string, node: string, unschedulable: boolean, } | { "action": "drain", space: string, node: string, } | { "action": "trigger", space: string, namespace: string, name: string, } | { "action": "suspend", space: string, target: ResourceRef, suspend: boolean, } | { "action": "undo", space: string, } | { "action": "reveal", object: SubscriptionId, key: string, } | { "action": "apply", space: string, preview: PreviewId, } | { "action": "shell", target: ShellTarget, kind: ShellKind, };

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

/**
 * What a preview prepared, kept in Rust for the window that asked until a
 * plan takes it (`PlanRequest::Apply`) or the window goes; a newer preview
 * of the same object replaces it.
 */
export type PreviewId = number;

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
 * What the gate takes a request for (ARCHITECTURE 6.4).
 */
export type RequestClass = "read" | "dryRun" | "write" | "secretRead" | "forward" | "exec";

/**
 * A resource the space's clusters serve, from discovery: what the explorer
 * lists and what `:` in quick access resolves names against (ARCHITECTURE 4.5).
 */
export type Resource = { gvr: Gvr, kind: string, singular: string, shortNames: Array<string>, namespaced: boolean, 
/**
 * Its subresources as discovery names them: `status`, `scale`.
 */
subresources: Array<string>, };

/**
 * An object of a space, by its resource as discovery names it.
 */
export type ResourceRef = { gvr: Gvr, namespaced: boolean, 
/**
 * None for a cluster-scoped object.
 */
namespace: string | null, name: string, };

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

/**
 * Names a kind of the cluster a space reaches.
 */
export type SchemaQuery = { space: string, 
/**
 * Empty for the core group.
 */
group: string, version: string, kind: string, };

export type Section = { 
/**
 * Stable, such as `core.metadata`; folding is kept by it.
 */
id: string, title: string, blocks: Array<Block>, };

/**
 * Marks a context as an environment type; none says it has no type, whatever
 * its kubeconfig says.
 */
export type SetContextEnvironment = { context: string, environment: Environment | null, };

/**
 * Sets the person's mode for a context; none goes back to what the rest
 * says.
 */
export type SetContextMode = { context: string, mode: Mode | null, };

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
 * How many bytes of output the terminal has parsed since the last ack.
 */
export type ShellAck = { id: SubscriptionId, bytes: number, };

/**
 * The containers of a pod a shell can reach, those that run.
 */
export type ShellContainers = { containers: Array<string>, 
/**
 * The one its `kubectl.kubernetes.io/default-container` annotation
 * names, when that one runs, else the first of `containers`.
 */
default: string, };

/**
 * Why a session ended; none can resume, as an exec cannot.
 */
export type ShellEnd = { "reason": "exited", code: number, } | { "reason": "detached" } | { "reason": "noShell", message: string, } | { "reason": "failed", error: IpcError, } | { "reason": "connectionLost" } | { "reason": "relocked" };

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
 * How a session goes; `ended` comes last, after all of its output.
 */
export type ShellEvent = { "state": "queued" } | { "state": "connecting" } | { "state": "running" } | { "state": "ended", end: ShellEnd, };

/**
 * What the person typed or pasted, in the order the webview sends it, one
 * call at a time.
 */
export type ShellInput = { id: SubscriptionId, data: Array<number>, };

export type ShellKind = "shell" | "attach";

/**
 * What a session's channel carries: its output as bytes, and its events.
 * Only TypeScript reads this type, which Rust sends as two kinds of body.
 */
export type ShellMessage = ArrayBuffer | ShellEvent;

/**
 * A pod a shell may be opened in.
 */
export type ShellPod = { space: string, namespace: string, pod: string, };

export type ShellResize = { id: SubscriptionId, cols: number, rows: number, };

export type ShellTarget = { space: string, namespace: string, pod: string, container: string, };

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
  context_mode_set: { request: SetContextMode; response: null; message: null };
  context_environment_set: { request: SetContextEnvironment; response: null; message: null };
  context_unlock: { request: string; response: null; message: null };
  context_relock: { request: string; response: null; message: null };
  command_plan: { request: PlanRequest; response: Plan; message: null };
  command_execute: { request: Execute; response: null; message: OperationEvent };
  command_cancel: { request: PlanId; response: null; message: null };
  access_review: { request: AccessQuery; response: Array<boolean>; message: null };
  apply_preview: { request: ApplyRequest; response: ApplyPreviewed; message: null };
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
  schema_get: { request: SchemaQuery; response: string; message: null };
  shell_containers: { request: ShellPod; response: ShellContainers; message: null };
  shell_open: { request: OpenShell; response: null; message: ShellMessage };
  shell_input: { request: ShellInput; response: null; message: null };
  shell_resize: { request: ShellResize; response: null; message: null };
  shell_ack: { request: ShellAck; response: null; message: null };
  shell_close: { request: SubscriptionId; response: null; message: null };
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
