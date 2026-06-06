import { invoke } from "@tauri-apps/api/core";

export interface ContextSummary {
  name: string;
  description: string;
  url: string;
  authMethod: string;
  hasTls: boolean;
  selected: boolean;
}

export function listContexts(dir?: string | null): Promise<ContextSummary[]> {
  return invoke<ContextSummary[]>("list_contexts", { dir: dir ?? null });
}

export function defaultContextDir(): Promise<string | null> {
  return invoke<string | null>("default_context_dir");
}
