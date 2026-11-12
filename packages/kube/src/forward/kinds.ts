import type { Gvr } from "@twigo/protocol";

const WORKLOADS: ReadonlySet<string> = new Set([
  "deployments",
  "replicasets",
  "statefulsets",
  "daemonsets",
]);

/** Whether a resource is a pod, the one target that is also the pod its connections reach. */
export function isPod({ group, resource }: Gvr): boolean {
  return group === "" && resource === "pods";
}

/** Whether a resource has a port to forward: a pod's, a Service's, or a workload's (ARCHITECTURE 4.6). */
export function canForward({ group, resource }: Gvr): boolean {
  if (group === "") return resource === "pods" || resource === "services";
  return group === "apps" && WORKLOADS.has(resource);
}
