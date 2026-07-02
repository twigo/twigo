import { Radio } from "lucide-react";
import { registerWatermark } from "@/shell/watermark";
import { registerStatusSegment } from "@/shell/statusBar";
import { registerDomain } from "@/shell/domains";
import { ConnectionSwitcher } from "@/components/connections/ConnectionSwitcher";
import { useConnections } from "@/store/connections";
// Conn-scoped stores register themselves for teardown on import (via
// registerConnScoped). Import them here so registration is eager and explicit -
// a load-bearing constraint, not a side effect of a view happening to render.
import "@/store/subjects";
import "@/store/jetstream";
import "@/store/kv";
import "@/store/objstore";
import "@/store/monitor";
import { registerNatsViews } from "./views";
import { registerNatsCommands } from "./commands";
import { NatsWatermark } from "./Watermark";
import { NatsConnectionStatus } from "./StatusSegments";

// The NATS domain module: the single place that contributes NATS views,
// commands, status segments and the editor watermark to the shell registries.
// Called once from main.tsx so the workbench shell stays domain-free - a future
// registerKubernetesModule() would sit beside this, not replace any shell code.
let registered = false;

export function registerNatsModule(): void {
  if (registered) return; // idempotent - a double call mustn't double-register
  registered = true;

  registerDomain({
    id: "nats",
    title: "NATS",
    icon: Radio,
    order: 1,
    default: true,
    ConnectionBar: ConnectionSwitcher,
    // Space targets are the imported NATS contexts; pinning one makes the tab
    // "NATS · <context>" and re-activates that context when the tab focuses.
    listTargets: () =>
      useConnections.getState().contexts.map((c) => ({
        id: c.name,
        label: c.name,
      })),
    activateTarget: (id) => useConnections.getState().setActive(id),
  });
  registerNatsViews();
  registerNatsCommands();
  registerWatermark(NatsWatermark);
  registerStatusSegment({
    id: "nats.connection",
    side: "left",
    render: NatsConnectionStatus,
  });
}
