import { Server } from "lucide-react";
import type { ViewProps } from "@/shell/views";
import { NODES } from "@/modules/k8s/mock";
import { ResourceList, type ResourceRow } from "./ResourceList";

export function NodesView({ filter }: ViewProps) {
  const rows: ResourceRow[] = NODES.map((n) => ({
    id: n.name,
    name: n.name,
    status: n.status,
    meta: `${n.role} · ${n.ready ? "Ready" : "NotReady"} · ${n.version}`,
  }));
  return <ResourceList rows={rows} filter={filter} icon={Server} noun="nodes" />;
}
