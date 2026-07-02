import type { FC } from "react";
import type { LucideIcon } from "lucide-react";

// Sidebar views ("viewlets"). A domain module registers its views; the activity
// bar and sidebar render from this registry, so the shell never imports a
// domain view component. A view without a Panel shows a "coming soon" state.

export interface ViewProps {
  filter: string;
  connId: string | null;
}

export interface ViewDef {
  id: string;
  title: string;
  icon: LucideIcon;
  order?: number;
  // The view the shell lands on when none is chosen. The shell never names a
  // view itself; a domain module opts one in.
  default?: boolean;
  // The domain that owns this view (e.g. "nats", "kubernetes"). The shell shows
  // only the active domain's views; undefined means "every domain".
  domain?: string;
  Panel?: FC<ViewProps>;
}

const views = new Map<string, ViewDef>();

export function registerView(def: ViewDef): void {
  views.set(def.id, def);
}

export function getViews(domain?: string): ViewDef[] {
  // Stable sort: same `order` keeps registration order.
  const all = [...views.values()].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0),
  );
  if (domain === undefined) return all;
  return all.filter((v) => v.domain === undefined || v.domain === domain);
}

export function getView(id: string): ViewDef | undefined {
  return views.get(id);
}

// The id the shell should show when the user hasn't picked a view: a module's
// opted-in default, else the first registered view, else nothing. Scoped to a
// domain when given, so each domain resolves its own landing view.
export function getDefaultViewId(domain?: string): string {
  const all = getViews(domain);
  return (all.find((v) => v.default) ?? all[0])?.id ?? "";
}

// Test-only: drop registered views so a suite starts clean.
export function clearViews(): void {
  views.clear();
}
