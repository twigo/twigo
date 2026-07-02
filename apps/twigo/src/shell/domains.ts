import type { FC } from "react";
import type { LucideIcon } from "lucide-react";

// Domains ("products"): NATS, Kubernetes, … A domain module registers itself;
// the shell renders the domain switcher and filters views by the active domain,
// so the workbench never names a domain itself. This is the second registry the
// shell needs to host more than one product side by side - it sits beside the
// view registry and works the same way.

// A concrete place a space can point at (a NATS context, a K8s cluster, …).
// A space tab then reads "NATS · prod-eu", not just "NATS" - like a browser
// tab is a site, not "the web".
export interface DomainTarget {
  id: string;
  label: string;
}

export interface DomainDef {
  id: string;
  title: string;
  icon: LucideIcon;
  order?: number;
  // The domain the shell lands on when none is chosen. A module opts one in; the
  // shell never names a domain itself.
  default?: boolean;
  // The per-domain connection/target bar shown at the top of the sidebar (NATS
  // connection switcher, Kubernetes cluster switcher, …). Optional: a domain may
  // have no notion of a connection.
  ConnectionBar?: FC;
  // The domain's targets for the space "+" picker, and the hook a space calls
  // when it activates with a pinned target. Both optional: a domain without a
  // notion of targets still gets plain technology tabs.
  listTargets?: () => DomainTarget[];
  activateTarget?: (targetId: string) => void;
}

const domains = new Map<string, DomainDef>();

export function registerDomain(def: DomainDef): void {
  domains.set(def.id, def);
}

export function getDomains(): DomainDef[] {
  // Stable sort: same `order` keeps registration order.
  return [...domains.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function getDomain(id: string): DomainDef | undefined {
  return domains.get(id);
}

// The id the shell should show when the user hasn't picked a domain: a module's
// opted-in default, else the first registered domain, else nothing.
export function getDefaultDomainId(): string {
  const all = getDomains();
  return (all.find((d) => d.default) ?? all[0])?.id ?? "";
}

// Test-only: drop registered domains so a suite starts clean.
export function clearDomains(): void {
  domains.clear();
}
