import { Rocket } from "lucide-react";
import type { ViewProps } from "@/shell/views";
import { DEPLOYMENTS } from "@/modules/k8s/mock";
import { ResourceList, type ResourceRow } from "./ResourceList";

export function DeploymentsView({ filter }: ViewProps) {
  const rows: ResourceRow[] = DEPLOYMENTS.map((d) => ({
    id: `${d.namespace}/${d.name}`,
    name: d.name,
    status: d.ready === d.desired ? "ok" : d.ready === 0 ? "error" : "warn",
    meta: `${d.namespace} · ${d.ready}/${d.desired} ready`,
  }));
  return (
    <ResourceList rows={rows} filter={filter} icon={Rocket} noun="deployments" />
  );
}
