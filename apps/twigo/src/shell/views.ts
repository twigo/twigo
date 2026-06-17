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
  Panel?: FC<ViewProps>;
}

const views = new Map<string, ViewDef>();

export function registerView(def: ViewDef): void {
  views.set(def.id, def);
}

export function getViews(): ViewDef[] {
  // Stable sort: same `order` keeps registration order.
  return [...views.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function getView(id: string): ViewDef | undefined {
  return views.get(id);
}

// The id the shell should show when the user hasn't picked a view: a module's
// opted-in default, else the first registered view, else nothing.
export function getDefaultViewId(): string {
  const all = getViews();
  return (all.find((v) => v.default) ?? all[0])?.id ?? "";
}

// Test-only: drop registered views so a suite starts clean.
export function clearViews(): void {
  views.clear();
}
