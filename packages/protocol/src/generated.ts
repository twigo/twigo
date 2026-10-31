// Generated from crates/twigo-ipc: TWIGO_UPDATE_TYPESCRIPT=1 cargo test -p twigo-ipc --test typescript

export type Ack = { id: SubscriptionId, seq: number, };

export type Cell = null | boolean | number | number | string;

export type Column = { name: string, kind: ColumnKind, 
/**
 * 0 is shown by default; higher only in the wide view.
 */
priority: number, };

export type ColumnKind = "string" | "integer" | "number" | "boolean" | "date" | "age" | "other";

export type Context = { name: string, 
/**
 * From the `twigo` extension of the kubeconfig context; none by default.
 */
color: ContextColor | null, };

export type ContextColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple";

export type ErrorKind = "invalidInput" | "notFound" | "conflict" | "forbidden" | "unauthorized" | "timeout" | "unavailable" | "internal";

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
upserts: Array<Row>, status: ViewState, };

export type ListQuery = { space: string, gvr: Gvr, 
/**
 * Empty for every namespace the space covers.
 */
namespaces: Array<string>, labelSelector: string | null, text: string | null, sort: Sort | null, };

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

export type SubscriptionId = number;

/**
 * The state of the upstream behind a subscription (ARCHITECTURE 3.7).
 */
export type ViewState = { "state": "queued" } | { "state": "connecting" } | { "state": "syncing", loaded: number, } | { "state": "ready" } | { "state": "relisting" } | { "state": "stale" } | { "state": "forbidden", verb: string, resource: string, } | { "state": "unauthorized" } | { "state": "error", error: IpcError, };

export type Window = { start: number, ids: Array<RowId>, };

export type Commands = {
  spaces_list: { request: null; response: Array<Space>; message: null };
  list_subscribe: { request: ListQuery; response: SubscriptionId; message: ListBatch };
  list_set_window: { request: SetWindow; response: null; message: null };
  list_ack: { request: Ack; response: null; message: null };
  list_unsubscribe: { request: SubscriptionId; response: null; message: null };
};
