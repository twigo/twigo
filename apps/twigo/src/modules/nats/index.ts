import { registerWatermark } from "@/shell/watermark";
import { registerStatusSegment } from "@/shell/statusBar";
import { registerNatsViews } from "./views";
import { registerNatsCommands } from "./commands";
import { NatsWatermark } from "./Watermark";
import { NatsConnectionStatus } from "./StatusSegments";

// The NATS domain module: the single place that contributes NATS views,
// commands, status segments and the editor watermark to the shell registries.
// Called once from main.tsx so the workbench shell stays domain-free — a future
// registerKubernetesModule() would sit beside this, not replace any shell code.
let registered = false;

export function registerNatsModule(): void {
  if (registered) return; // idempotent — a double call mustn't double-register
  registered = true;

  registerNatsViews();
  registerNatsCommands();
  registerWatermark(NatsWatermark);
  registerStatusSegment({
    id: "nats.connection",
    side: "left",
    render: NatsConnectionStatus,
  });
}
