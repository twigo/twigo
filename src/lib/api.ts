import { invoke } from "@tauri-apps/api/core";
import type { SubjectStat } from "@/lib/subject-tree";

export type { SubjectStat };

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
