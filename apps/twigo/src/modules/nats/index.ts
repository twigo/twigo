import { registerWatermark } from "@/shell/watermark";
import { NatsWatermark } from "./Watermark";

// The NATS domain module: the single place that contributes NATS views,
// commands, status segments and the editor watermark to the shell registries.
// Called once from main.tsx so the workbench shell stays domain-free — a future
// registerKubernetesModule() would sit beside this, not replace any shell code.
let registered = false;

export function registerNatsModule(): void {
  if (registered) return; // idempotent — a double call mustn't double-register
  registered = true;

  registerWatermark(NatsWatermark);
}
