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
