import { invoke as rawInvoke, Channel } from "@tauri-apps/api/core";
import { useReadOnly } from "@/store/readonly";
import type { SubjectStat } from "@twigo/utils";

export { Channel };
export type { SubjectStat };

// A backend error: a stable `kind` (see Rust `Error::kind`) the UI can branch on
// plus the human message. Extends Error and stringifies to just the message, so
// existing `String(e)` / `${e}` sites keep rendering it cleanly.
export class IpcError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.name = "IpcError";
    this.kind = kind;
  }
  override toString(): string {
    return this.message;
  }
}

/** Normalize any caught value into a typed IpcError. */
export function ipcError(e: unknown): IpcError {
  if (e instanceof IpcError) return e;
  if (typeof e === "object" && e !== null && "kind" in e && "message" in e) {
    return new IpcError(String(e.kind), String(e.message));
  }
  if (e instanceof Error) return new IpcError("unknown", e.message);
  return new IpcError("unknown", typeof e === "string" ? e : String(e));
}

// Every command goes through here, so a rejected invoke surfaces as a typed
// IpcError instead of a raw { kind, message } object.
function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return rawInvoke<T>(cmd, args).catch((e: unknown) => {
    throw ipcError(e);
  });
}

// Per-connection read-only guardrail. Every write command calls this first so an
// accidental mutation on a locked connection is blocked before it reaches the
// server. Throws an IpcError the caller's existing catch surfaces as a toast.
function assertWritable(connId: string): void {
  if (useReadOnly.getState().isReadOnly(connId)) {
    throw new IpcError(
      "readOnly",
      `${connId} is read-only — writes are blocked`,
    );
  }
}

export interface IncomingMessage {
  subject: string;
  reply: string | null;
  payloadB64: string;
  headers: [string, string][];
  size: number;
}

export interface ContextSummary {
  name: string;
  description: string;
  url: string;
  authMethod: string;
  hasTls: boolean;
  selected: boolean;
}

export interface ConnInfo {
  name: string;
  serverName: string;
  serverVersion: string;
  rttMs: number;
  jetstream: boolean;
  maxPayload: number;
  connected: boolean;
}

export interface NatsEvent {
  conn: string;
  kind: string;
  detail?: string | null;
}

export interface ReconnectEvent {
  conn: string;
  attempt: number;
  delayMs: number;
}

export function listContexts(dir?: string | null): Promise<ContextSummary[]> {
  return call<ContextSummary[]>("list_contexts", { dir: dir ?? null });
}

export function defaultContextDir(): Promise<string | null> {
  return call<string | null>("default_context_dir");
}

export function connect(name: string, dir?: string | null): Promise<ConnInfo> {
  return call<ConnInfo>("connect", { name, dir: dir ?? null });
}

export async function disconnect(name: string): Promise<void> {
  await call("disconnect", { name });
}

export function listConnections(): Promise<string[]> {
  return call<string[]>("list_connections");
}

export function connInfo(name: string): Promise<ConnInfo> {
  return call<ConnInfo>("conn_info", { name });
}

export interface ServerDetails {
  name: string;
  serverId: string;
  serverName: string;
  version: string;
  go: string;
  host: string;
  port: number;
  clientId: number;
  clientIp: string;
  proto: number;
  maxPayload: number;
  headers: boolean;
  authRequired: boolean;
  tlsRequired: boolean;
  jetstream: boolean;
  lameDuckMode: boolean;
  cluster: string | null;
  domain: string | null;
  connectUrls: string[];
  rttMs: number;
}

export function serverInfo(name: string): Promise<ServerDetails> {
  return call<ServerDetails>("server_info", { name });
}

export interface SubjectsUpdate {
  conn: string;
  subjects: SubjectStat[];
  truncated: boolean;
}

export async function startSubjectWatch(
  connId: string,
  pattern?: string | null,
): Promise<void> {
  await call("start_subject_watch", { connId, pattern: pattern ?? null });
}

export async function stopSubjectWatch(connId: string): Promise<void> {
  await call("stop_subject_watch", { connId });
}

export async function subscribe(
  connId: string,
  subId: string,
  subject: string,
  onMessage: Channel<IncomingMessage>,
): Promise<void> {
  await call("subscribe", { connId, subId, subject, onMessage });
}

export async function unsubscribe(subId: string): Promise<void> {
  await call("unsubscribe", { subId });
}

export async function publish(
  connId: string,
  subject: string,
  payload: string,
  headers: [string, string][] = [],
): Promise<void> {
  assertWritable(connId);
  await call("publish", { connId, subject, payload, headers });
}

export async function request(
  connId: string,
  subject: string,
  payload: string,
  timeoutMs?: number | null,
  headers: [string, string][] = [],
): Promise<IncomingMessage> {
  assertWritable(connId);
  return call<IncomingMessage>("request", {
    connId,
    subject,
    payload,
    timeoutMs: timeoutMs ?? null,
    headers,
  });
}

export interface StreamSummary {
  name: string;
  subjects: string[];
  messages: number;
  bytes: number;
  firstSeq: number;
  lastSeq: number;
  consumerCount: number;
  storage: string;
  retention: string;
}

export interface ConsumerSummary {
  name: string;
  durable: boolean;
  kind: string;
  ackPolicy: string;
  numPending: number;
  numAckPending: number;
  numRedelivered: number;
  paused: boolean;
}

export interface StreamDetail {
  config: Record<string, unknown>;
  created: string | null;
  messages: number;
  bytes: number;
  firstSeq: number;
  firstTs: string | null;
  lastSeq: number;
  lastTs: string | null;
  consumerCount: number;
  numSubjects: number;
  numDeleted: number;
}

export interface ConsumerDetail {
  config: Record<string, unknown>;
  created: string | null;
  numPending: number;
  numAckPending: number;
  numRedelivered: number;
  numWaiting: number;
  deliveredConsumerSeq: number;
  deliveredStreamSeq: number;
  ackFloorConsumerSeq: number;
  ackFloorStreamSeq: number;
  paused: boolean;
}

export function jsListStreams(connId: string): Promise<StreamSummary[]> {
  return call<StreamSummary[]>("js_list_streams", { connId });
}

export function jsStreamDetail(
  connId: string,
  stream: string,
): Promise<StreamDetail> {
  return call<StreamDetail>("js_stream_detail", { connId, stream });
}

export function jsListConsumers(
  connId: string,
  stream: string,
): Promise<ConsumerSummary[]> {
  return call<ConsumerSummary[]>("js_list_consumers", { connId, stream });
}

export function jsConsumerDetail(
  connId: string,
  stream: string,
  consumer: string,
): Promise<ConsumerDetail> {
  return call<ConsumerDetail>("js_consumer_detail", {
    connId,
    stream,
    consumer,
  });
}

export interface StoredMessage {
  seq: number;
  subject: string;
  time: string | null;
  size: number;
  payloadB64: string;
  headers: [string, string][];
  truncated: boolean;
}

export interface MessagePage {
  messages: StoredMessage[];
  nextSeq: number | null;
}

export function jsGetMessages(
  connId: string,
  stream: string,
  start: number | null,
  limit: number,
  backward: boolean,
): Promise<MessagePage> {
  return call<MessagePage>("js_get_messages", {
    connId,
    stream,
    start,
    limit,
    backward,
  });
}

export async function jsCreateStream(
  connId: string,
  config: Record<string, unknown>,
): Promise<void> {
  assertWritable(connId);
  await call("js_create_stream", { connId, config });
}

export async function jsUpdateStream(
  connId: string,
  config: Record<string, unknown>,
): Promise<void> {
  assertWritable(connId);
  await call("js_update_stream", { connId, config });
}

export async function jsCreateConsumer(
  connId: string,
  stream: string,
  config: Record<string, unknown>,
): Promise<void> {
  assertWritable(connId);
  await call("js_create_consumer", { connId, stream, config });
}

export async function jsPurgeStream(
  connId: string,
  stream: string,
  keep: number | null,
  upToSeq: number | null,
): Promise<{ purged: number }> {
  assertWritable(connId);
  return call<{ purged: number }>("js_purge_stream", {
    connId,
    stream,
    keep,
    upToSeq,
  });
}

export async function jsDeleteStream(
  connId: string,
  stream: string,
): Promise<void> {
  assertWritable(connId);
  await call("js_delete_stream", { connId, stream });
}

export async function jsDeleteConsumer(
  connId: string,
  stream: string,
  consumer: string,
): Promise<void> {
  assertWritable(connId);
  await call("js_delete_consumer", { connId, stream, consumer });
}

export async function jsPauseConsumer(
  connId: string,
  stream: string,
  consumer: string,
): Promise<void> {
  assertWritable(connId);
  await call("js_pause_consumer", { connId, stream, consumer });
}

export async function jsResumeConsumer(
  connId: string,
  stream: string,
  consumer: string,
): Promise<void> {
  assertWritable(connId);
  await call("js_resume_consumer", { connId, stream, consumer });
}

export async function jsDeleteMessage(
  connId: string,
  stream: string,
  seq: number,
): Promise<void> {
  assertWritable(connId);
  await call("js_delete_message", { connId, stream, seq });
}

export interface KvBucketSummary {
  bucket: string;
  values: number;
  bytes: number;
  history: number;
  maxAge: number;
  storage: string;
}

export interface KvBucketDetail {
  bucket: string;
  values: number;
  bytes: number;
  history: number;
  maxAge: number;
  storage: string;
  maxValueSize: number;
  replicas: number;
}

export interface KvEntrySummary {
  key: string;
  revision: number;
  created: string | null;
  operation: string;
  delta: number;
  size: number;
}

export interface KvEntryDetail {
  key: string;
  revision: number;
  created: string | null;
  operation: string;
  delta: number;
  size: number;
  payloadB64: string;
  truncated: boolean;
}

export function kvListBuckets(connId: string): Promise<KvBucketSummary[]> {
  return call<KvBucketSummary[]>("kv_list_buckets", { connId });
}

export function kvBucketInfo(
  connId: string,
  bucket: string,
): Promise<KvBucketDetail> {
  return call<KvBucketDetail>("kv_bucket_info", { connId, bucket });
}

export function kvListKeys(
  connId: string,
  bucket: string,
): Promise<KvEntrySummary[]> {
  return call<KvEntrySummary[]>("kv_list_keys", { connId, bucket });
}

export function kvGetEntry(
  connId: string,
  bucket: string,
  key: string,
  revision: number | null,
): Promise<KvEntryDetail | null> {
  return call<KvEntryDetail | null>("kv_get_entry", {
    connId,
    bucket,
    key,
    revision,
  });
}

export function kvHistory(
  connId: string,
  bucket: string,
  key: string,
): Promise<KvEntrySummary[]> {
  return call<KvEntrySummary[]>("kv_history", { connId, bucket, key });
}

export async function kvPut(
  connId: string,
  bucket: string,
  key: string,
  payloadB64: string,
  revision: number | null,
): Promise<{ revision: number }> {
  assertWritable(connId);
  return call<{ revision: number }>("kv_put", {
    connId,
    bucket,
    key,
    payloadB64,
    revision,
  });
}

export async function kvCreate(
  connId: string,
  bucket: string,
  key: string,
  payloadB64: string,
): Promise<{ revision: number }> {
  assertWritable(connId);
  return call<{ revision: number }>("kv_create", {
    connId,
    bucket,
    key,
    payloadB64,
  });
}

export async function kvDelete(
  connId: string,
  bucket: string,
  key: string,
): Promise<void> {
  assertWritable(connId);
  await call("kv_delete", { connId, bucket, key });
}

export async function kvPurge(
  connId: string,
  bucket: string,
  key: string,
): Promise<void> {
  assertWritable(connId);
  await call("kv_purge", { connId, bucket, key });
}

export async function kvCreateBucket(
  connId: string,
  config: Record<string, unknown>,
): Promise<void> {
  assertWritable(connId);
  await call("kv_create_bucket", { connId, config });
}

export async function kvDeleteBucket(
  connId: string,
  bucket: string,
): Promise<void> {
  assertWritable(connId);
  await call("kv_delete_bucket", { connId, bucket });
}

export interface ObjBucketSummary {
  bucket: string;
  bytes: number;
  storage: string;
}

export interface ObjSummary {
  name: string;
  size: number;
  chunks: number;
  modified: string | null;
  deleted: boolean;
}

export interface ObjDetail {
  name: string;
  description: string | null;
  size: number;
  chunks: number;
  modified: string | null;
  digest: string | null;
  deleted: boolean;
  metadata: Record<string, string>;
  headers: [string, string][];
}

export function objListBuckets(connId: string): Promise<ObjBucketSummary[]> {
  return call<ObjBucketSummary[]>("obj_list_buckets", { connId });
}

export function objListObjects(
  connId: string,
  bucket: string,
): Promise<ObjSummary[]> {
  return call<ObjSummary[]>("obj_list_objects", { connId, bucket });
}

export function objObjectInfo(
  connId: string,
  bucket: string,
  name: string,
): Promise<ObjDetail> {
  return call<ObjDetail>("obj_object_info", { connId, bucket, name });
}

export async function objGetObject(
  connId: string,
  bucket: string,
  name: string,
  dest: string,
): Promise<void> {
  await call("obj_get_object", { connId, bucket, name, dest });
}

export async function objPutObject(
  connId: string,
  bucket: string,
  name: string,
  src: string,
): Promise<void> {
  assertWritable(connId);
  await call("obj_put_object", { connId, bucket, name, src });
}

export async function objDelete(
  connId: string,
  bucket: string,
  name: string,
): Promise<void> {
  assertWritable(connId);
  await call("obj_delete", { connId, bucket, name });
}

export async function objCreateBucket(
  connId: string,
  config: Record<string, unknown>,
): Promise<void> {
  assertWritable(connId);
  await call("obj_create_bucket", { connId, config });
}

export async function objDeleteBucket(
  connId: string,
  bucket: string,
): Promise<void> {
  assertWritable(connId);
  await call("obj_delete_bucket", { connId, bucket });
}

export interface Varz {
  serverId: string;
  serverName: string;
  version: string;
  host: string;
  port: number;
  maxPayload: number;
  now: string;
  uptime: string;
  mem: number;
  cores: number;
  cpu: number;
  connections: number;
  totalConnections: number;
  subscriptions: number;
  inMsgs: number;
  inBytes: number;
  outMsgs: number;
  outBytes: number;
  slowConsumers: number;
  routes: number;
  remotes: number;
  leafnodes: number;
  cluster: { name: string | null };
  lameDuckMode: boolean;
}

export interface Jsz {
  memory: number;
  storage: number;
  reservedMemory: number;
  reservedStorage: number;
  accounts: number;
  haAssets: number;
  streams: number;
  consumers: number;
  messages: number;
  bytes: number;
  config: { maxMemory: number; maxStorage: number };
  api: { level: number; total: number; errors: number };
}

export interface Healthz {
  status: string;
  statusCode: number;
}

export function monitorVarz(
  connId: string,
  monitoringUrl: string | null,
): Promise<Varz> {
  return call<Varz>("monitor_varz", { connId, monitoringUrl });
}

export function monitorJsz(
  connId: string,
  monitoringUrl: string | null,
): Promise<Jsz> {
  return call<Jsz>("monitor_jsz", { connId, monitoringUrl });
}

export function monitorHealthz(
  connId: string,
  monitoringUrl: string | null,
): Promise<Healthz> {
  return call<Healthz>("monitor_healthz", { connId, monitoringUrl });
}

export interface ConnzConn {
  cid: number;
  name: string;
  lang: string;
  version: string;
  ip: string;
  port: number;
  account: string | null;
  subscriptions: number;
  pendingBytes: number;
  inMsgs: number;
  outMsgs: number;
  inBytes: number;
  outBytes: number;
  rtt: string;
  idle: string;
  uptime: string;
  lastActivity: string;
}

export interface Connz {
  now: string;
  numConnections: number;
  total: number;
  offset: number;
  limit: number;
  connections: ConnzConn[];
}

export function monitorConnz(
  connId: string,
  sort: string,
  limit: number,
  offset: number,
  monitoringUrl: string | null,
): Promise<Connz> {
  return call<Connz>("monitor_connz", {
    connId,
    sort,
    limit,
    offset,
    monitoringUrl,
  });
}

// One varz per cluster node (PING fan-in); HTTP / single-server reply has 1.
export function monitorCluster(
  connId: string,
  monitoringUrl: string | null,
): Promise<Varz[]> {
  return call<Varz[]>("monitor_cluster", { connId, monitoringUrl });
}
