import type { Gvr } from "@twigo/protocol";

/** Whether a resource has shells: a pod's (ARCHITECTURE 4.4). */
export function canShell(gvr: Gvr): boolean {
  return gvr.group === "" && gvr.resource === "pods";
}
