import { invoke, Channel } from "@tauri-apps/api/core";
import type { SubjectStat } from "@twigo/utils";

export { Channel };
export type { SubjectStat };

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
}

export interface ReconnectEvent {
  conn: string;
  attempt: number;
  delayMs: number;
}

export function listContexts(dir?: string | null): Promise<ContextSummary[]> {
  return invoke<ContextSummary[]>("list_contexts", { dir: dir ?? null });
}

export function defaultContextDir(): Promise<string | null> {
  return invoke<string | null>("default_context_dir");
}

export function connect(name: string, dir?: string | null): Promise<ConnInfo> {
  return invoke<ConnInfo>("connect", { name, dir: dir ?? null });
}

export async function disconnect(name: string): Promise<void> {
  await invoke("disconnect", { name });
}

export function listConnections(): Promise<string[]> {
  return invoke<string[]>("list_connections");
}

export function connInfo(name: string): Promise<ConnInfo> {
  return invoke<ConnInfo>("conn_info", { name });
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
  return invoke<ServerDetails>("server_info", { name });
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
  await invoke("start_subject_watch", { connId, pattern: pattern ?? null });
}

export async function stopSubjectWatch(connId: string): Promise<void> {
  await invoke("stop_subject_watch", { connId });
}

export async function subscribe(
  connId: string,
  subId: string,
  subject: string,
  onMessage: Channel<IncomingMessage>,
): Promise<void> {
  await invoke("subscribe", { connId, subId, subject, onMessage });
}

export async function unsubscribe(subId: string): Promise<void> {
  await invoke("unsubscribe", { subId });
}

export async function publish(
  connId: string,
  subject: string,
  payload: string,
  headers: [string, string][] = [],
): Promise<void> {
  await invoke("publish", { connId, subject, payload, headers });
}

export function request(
  connId: string,
  subject: string,
  payload: string,
  timeoutMs?: number | null,
  headers: [string, string][] = [],
): Promise<IncomingMessage> {
  return invoke<IncomingMessage>("request", {
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
  return invoke<StreamSummary[]>("js_list_streams", { connId });
}

export function jsStreamDetail(
  connId: string,
  stream: string,
): Promise<StreamDetail> {
  return invoke<StreamDetail>("js_stream_detail", { connId, stream });
}

export function jsListConsumers(
  connId: string,
  stream: string,
): Promise<ConsumerSummary[]> {
  return invoke<ConsumerSummary[]>("js_list_consumers", { connId, stream });
}

export function jsConsumerDetail(
  connId: string,
  stream: string,
  consumer: string,
): Promise<ConsumerDetail> {
  return invoke<ConsumerDetail>("js_consumer_detail", {
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
  return invoke<MessagePage>("js_get_messages", {
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
  await invoke("js_create_stream", { connId, config });
}

export async function jsUpdateStream(
  connId: string,
  config: Record<string, unknown>,
): Promise<void> {
  await invoke("js_update_stream", { connId, config });
}

export async function jsCreateConsumer(
  connId: string,
  stream: string,
  config: Record<string, unknown>,
): Promise<void> {
  await invoke("js_create_consumer", { connId, stream, config });
}

export function jsPurgeStream(
  connId: string,
  stream: string,
  keep: number | null,
  upToSeq: number | null,
): Promise<{ purged: number }> {
  return invoke<{ purged: number }>("js_purge_stream", {
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
  await invoke("js_delete_stream", { connId, stream });
}

export async function jsDeleteConsumer(
  connId: string,
  stream: string,
  consumer: string,
): Promise<void> {
  await invoke("js_delete_consumer", { connId, stream, consumer });
}

export async function jsPauseConsumer(
  connId: string,
  stream: string,
  consumer: string,
): Promise<void> {
  await invoke("js_pause_consumer", { connId, stream, consumer });
}

export async function jsResumeConsumer(
  connId: string,
  stream: string,
  consumer: string,
): Promise<void> {
  await invoke("js_resume_consumer", { connId, stream, consumer });
}

export async function jsDeleteMessage(
  connId: string,
  stream: string,
  seq: number,
): Promise<void> {
  await invoke("js_delete_message", { connId, stream, seq });
}
