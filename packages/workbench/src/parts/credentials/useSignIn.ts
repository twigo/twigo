import type { ExecPlugin, PluginStatus } from "@twigo/protocol";
import { useChanges, useWorkbench } from "../../react";

export type Shown = Extract<
  PluginStatus,
  { state: "running" } | { state: "failed" }
>;

/** The plugin's run, while it runs or after it failed. */
export function useSignIn():
  { plugin: ExecPlugin; status: Shown; context: string } | undefined {
  const { credentials } = useWorkbench();
  useChanges(credentials.changes);
  const { auth, context } = credentials;
  if (auth.state !== "plugin" || context === undefined) return undefined;
  const { status } = auth;
  if (status.state !== "running" && status.state !== "failed") return undefined;
  return { plugin: auth.plugin, status, context };
}
