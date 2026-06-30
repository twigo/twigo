import { Network } from "lucide-react";
import type { ViewProps } from "@/shell/views";
import { SERVICES } from "@/modules/k8s/mock";
import { ResourceList, type ResourceRow } from "./ResourceList";

export function ServicesView({ filter }: ViewProps) {
  const rows: ResourceRow[] = SERVICES.map((s) => ({
    id: `${s.namespace}/${s.name}`,
    name: s.name,
    status: "ok",
    meta: `${s.type} · ${s.clusterIp}`,
  }));
  return (
    <ResourceList rows={rows} filter={filter} icon={Network} noun="services" />
  );
}
