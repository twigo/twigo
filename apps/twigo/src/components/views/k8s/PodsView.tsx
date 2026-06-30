import { Box } from "lucide-react";
import type { ViewProps } from "@/shell/views";
import { PODS } from "@/modules/k8s/mock";
import { ResourceList, type ResourceRow } from "./ResourceList";

export function PodsView({ filter }: ViewProps) {
  const rows: ResourceRow[] = PODS.map((p) => ({
    id: `${p.namespace}/${p.name}`,
    name: p.name,
    status: p.status,
    meta: `${p.namespace} · ${p.phase}${p.restarts ? ` · ${p.restarts}↺` : ""}`,
  }));
  return <ResourceList rows={rows} filter={filter} icon={Box} noun="pods" />;
}
