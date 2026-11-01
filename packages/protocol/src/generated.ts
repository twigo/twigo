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

export type Context = { name: string, 
/**
 * From the `twigo` extension of the kubeconfig context; none by default.
 */
color: ContextColor | null, };

export type ContextColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple";

export type ErrorKind = "invalidInput" | "notFound" | "conflict" | "forbidden" | "unauthorized" | "timeout" | "unavailable" | "internal";

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

/**
 * A resource the space's clusters serve, from discovery: what the explorer
 * lists and what `:` in quick access resolves names against (ARCHITECTURE 4.5).
 */
export type Resource = { gvr: Gvr, kind: string, singular: string, shortNames: Array<string>, namespaced: boolean, };

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

export type Sort = { 
/**
 * A column name from [`ListBatch::columns`].
 */
column: string, descending: boolean, };

/**
 * A workbench space: one context or a group of them (ARCHITECTURE 4.2).
 */
export type Space = { id: string, name: string, contexts: Array<Context>, };

/**
 * UI state that is not settings (ARCHITECTURE 4.8): a space's layout, the
 * command history. The value is JSON the webview writes and reads back;
 * the core stores it without looking inside.
 */
export type StateEntry = { key: string, value: string, };

export type SubscriptionId = number;

/**
 * The state of the upstream behind a subscription (ARCHITECTURE 3.7).
 */
export type ViewState = { "state": "queued" } | { "state": "connecting" } | { "state": "syncing", loaded: number, } | { "state": "ready" } | { "state": "relisting" } | { "state": "stale" } | { "state": "forbidden", verb: string, resource: string, } | { "state": "unauthorized" } | { "state": "error", error: IpcError, };

export type Window = { start: number, ids: Array<RowId>, };

export type Commands = {
  spaces_list: { request: null; response: Array<Space>; message: null };
  contexts_list: { request: null; response: Array<Context>; message: null };
  space_open: { request: string; response: Space; message: null };
  resources_list: { request: string; response: Array<Resource>; message: null };
  namespaces_list: { request: string; response: Array<string>; message: null };
  cluster_version: { request: string; response: ClusterVersion; message: null };
  list_subscribe: { request: ListQuery; response: SubscriptionId; message: ListBatch };
  list_set_window: { request: SetWindow; response: null; message: null };
  list_ack: { request: Ack; response: null; message: null };
  list_unsubscribe: { request: SubscriptionId; response: null; message: null };
  keyboard_layout_watch: { request: null; response: KeyboardLayout; message: KeyboardLayout };
  state_get: { request: string; response: string | null; message: null };
  state_set: { request: StateEntry; response: null; message: null };
};
