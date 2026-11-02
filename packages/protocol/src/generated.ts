// Generated from crates/twigo-ipc: TWIGO_UPDATE_TYPESCRIPT=1 cargo test -p twigo-ipc --test typescript

export type Ack = { id: SubscriptionId, seq: number, };

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

/**
 * A context the catalog lists.
 */
export type Context = { name: string, 
/**
 * From the `twigo` extension of the kubeconfig context; none by default.
 */
color: ContextColor | null, };

/**
 * How a context gets its credentials.
 */
export type ContextAuth = { "state": "none" } | { "state": "invalid", message: string, } | { "state": "untrusted", plugin: ExecPlugin, } | { "state": "plugin", plugin: ExecPlugin, status: PluginStatus, };

export type ContextColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple";

/**
 * A context's resources as discovery last answered, or why it did not.
 */
export type Discovered = { "state": "ready", resources: Array<Resource>, } | { "state": "failed", error: IpcError, };

export type EnvVar = { name: string, value: string, };

export type ErrorKind = "invalidInput" | "notFound" | "conflict" | "forbidden" | "unauthorized" | "timeout" | "unavailable" | "internal";

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

export type GroupCount = { value: string, count: number, };

export type Gvr = { 
/**
 * Empty for the core group.
 */
group: string, version: string, resource: string, };

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

/**
 * One flush of a subscription. Rust sends the next batch only after the
 * webview acknowledged this one's `seq`, and coalesces changes meanwhile.
 */
export type ListBatch = { seq: number, 
/**
 * Rows matching the query, in or out of the window.
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
 * With `group_by`: the matching rows per value of that column, present
 * in the first batch and whenever a count changes.
 */
groups: Array<GroupCount> | null, };

export type ListQuery = { space: string, gvr: Gvr, 
/**
 * Empty for every namespace the space covers.
 */
namespaces: Array<string>, labelSelector: string | null, text: string | null, 
/**
 * The user's column choices by name, which the text filter follows:
 * true shows a column, false hides it, and the rest show by priority 0.
 * The server resolves them against its own columns, so a choice for a
 * column the list lacks, such as Namespace under one namespace, does
 * nothing. Null shows the columns of priority 0.
 */
columns: { [key in string]: boolean } | null, sort: Sort | null, 
/**
 * A column to count the matching rows by, such as a pod's Status.
 */
groupBy: string | null, 
/**
 * Keeps the rows whose column holds one of the values. The counts of
 * `group_by` come before it, so the values it drops keep theirs.
 */
values: ColumnValues | null, };

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
 * One per column; null in Age columns.
 */
cells: Array<Cell>, };

/**
 * `context/namespace/name`, or `context/name` for cluster-scoped objects.
 */
export type RowId = string;

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

export type SubscriptionId = number;

/**
 * The state of the upstream behind a subscription (ARCHITECTURE 3.7).
 */
export type ViewState = { "state": "queued" } | { "state": "connecting" } | { "state": "syncing", loaded: number, } | { "state": "ready" } | { "state": "relisting" } | { "state": "stale" } | { "state": "forbidden", verb: string, resource: string, } | { "state": "unauthorized" } | { "state": "error", error: IpcError, };

export type Window = { start: number, ids: Array<RowId>, };

export type Commands = {
  spaces_list: { request: null; response: Array<Space>; message: null };
  contexts_watch: { request: null; response: Array<Context>; message: Array<Context> };
  space_open: { request: string; response: Space; message: null };
  resources_watch: { request: string; response: Discovered; message: Discovered };
  namespaces_list: { request: string; response: Array<string>; message: null };
  cluster_version: { request: string; response: ClusterVersion; message: null };
  list_subscribe: { request: ListQuery; response: SubscriptionId; message: ListBatch };
  list_set_window: { request: SetWindow; response: null; message: null };
  list_ack: { request: Ack; response: null; message: null };
  list_unsubscribe: { request: SubscriptionId; response: null; message: null };
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
