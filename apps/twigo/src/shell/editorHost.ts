import type { DockviewApi } from "dockview-react";

// The shell's editor host: owns the Dockview api singleton and the generic,
// domain-free pane operations (open / close / split / focus / reset). Domain
// modules build their typed opens (openStream, openKvEntry, …) on top of
// openPanel, so the shell never learns a single editor type. Lives in src/shell
// so the boundary lint keeps it domain-free.

let api: DockviewApi | null = null;

export function setEditorApi(value: DockviewApi | null): void {
  api = value;
}

/** Whether an editor surface exists yet (don't open/subscribe without one). */
export function hasEditorApi(): boolean {
  return api !== null;
}

// Raised while the layout is being swapped (context switch) or torn down
// (connection loss), so EditorArea's listeners don't treat bulk panel removals
// as user closes or persist an empty layout. A depth counter (not a boolean) so
// nested regions compose; withReplacingLayout is the only mutator.
let replacingDepth = 0;
export function isReplacingLayout(): boolean {
  return replacingDepth > 0;
}
export function withReplacingLayout<T>(fn: () => T): T {
  replacingDepth += 1;
  try {
    return fn();
  } finally {
    replacingDepth -= 1;
  }
}

export interface PanelDescriptor {
  // The editor type id (Dockview component + tab name). The registry that maps
  // it to a component is owned by the domain, not the shell.
  component: string;
  id: string;
  title: string;
  params?: Record<string, unknown>;
  index?: number;
  // Replace an existing panel's params instead of only focusing it.
  replaceParams?: boolean;
}

/** Open a panel, or focus + optionally re-seed it if its id is already open. */
export function openPanel(desc: PanelDescriptor): void {
  if (!api) return;

  const existing = api.getPanel(desc.id);
  if (existing) {
    if (desc.replaceParams) {
      existing.api.updateParameters({ ...desc.params, type: desc.component });
    }
    existing.api.setActive();
    return;
  }

  const active = api.activeGroup;
  const panel = api.addPanel({
    id: desc.id,
    component: desc.component,
    tabComponent: desc.component,
    title: desc.title,
    // `type` is embedded so panels self-describe (used by teardown / restore).
    params: { ...desc.params, type: desc.component },
    ...(active && desc.index !== undefined
      ? { position: { referenceGroup: active.id, index: desc.index } }
      : {}),
  });
  panel.api.setActive();
}

export interface PanelInfo {
  id: string;
  params: Record<string, unknown> | undefined;
}

/** Every open panel's id + params, for domain teardown that closes by predicate. */
export function listPanels(): PanelInfo[] {
  return (api?.panels ?? []).map((p) => ({ id: p.id, params: p.params }));
}

/** Close a panel by id, if it is open. */
export function closePanel(id: string): void {
  api?.getPanel(id)?.api.close();
}

// --- Pane management (split / focus / reset) --------------------------------
// Dockview suppresses its add/remove-panel events during a programmatic move
// (the `_moving` lock), so moving a panel between groups never trips
// EditorArea's onDidRemovePanel teardown - live sessions survive.
// onDidLayoutChange still fires afterwards, so the new layout is persisted.

/** True when the active tab shares its group with others, so a split is visible. */
export function canSplitActiveEditor(): boolean {
  const active = api?.activePanel;
  return !!active && active.group.panels.length > 1;
}

/** Number of editor groups (panes) currently in the layout. */
export function editorGroupCount(): number {
  return api?.groups.length ?? 0;
}

/** Move the active tab into a new pane beside its group. */
export function splitActiveEditor(direction: "right" | "below"): void {
  const active = api?.activePanel;
  if (!api || !active) return;
  const group = api.addGroup({ referenceGroup: active.group, direction });
  active.api.moveTo({ group });
}

/** Cycle keyboard focus to the next editor group. */
export function focusNextEditorGroup(): void {
  api?.moveToNext({ includePanel: false });
}

/** Collapse every split back into a single pane (tabs and sessions preserved). */
export function resetEditorLayout(): void {
  if (!api) return;
  const target = api.groups[0];
  if (!target || api.groups.length <= 1) return;
  for (const panel of [...api.panels]) {
    if (panel.group !== target) panel.api.moveTo({ group: target });
  }
  target.panels[0]?.api.setActive();
}

// "settings" is the shell-owned editor; the editor registry must provide a
// component under this id. The shell emits the id but never imports the registry.
export function openSettings(): void {
  openPanel({
    component: "settings",
    id: "settings",
    title: "Settings",
    index: 0,
  });
}
