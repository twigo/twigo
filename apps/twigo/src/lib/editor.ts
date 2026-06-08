import type { DockviewApi } from "dockview-react";
import { useStream } from "@/store/stream";
import { EDITORS, type EditorType } from "@/components/editor/registry";

// Editor "inputs" (VS Code model): a type + a stable id. Opening the same id
// focuses the existing tab instead of duplicating it.
export type { EditorType };

interface EditorDescriptor {
  type: EditorType;
  id: string;
  title: string;
  params?: Record<string, unknown>;
  index?: number;
}

let api: DockviewApi | null = null;

export function setEditorApi(value: DockviewApi) {
  api = value;
}

// Encode the components: ':' is the delimiter but is legal in both NATS
// subjects and context names, so raw interpolation could collide.
function streamEditorId(connId: string, subject: string): string {
  return `stream:${encodeURIComponent(connId)}:${encodeURIComponent(subject)}`;
}

function serverEditorId(connId: string): string {
  return `server:${encodeURIComponent(connId)}`;
}

function openEditor(desc: EditorDescriptor): void {
  if (!api) return;

  const existing = api.getPanel(desc.id);
  if (existing) {
    existing.api.setActive();
    return;
  }

  const active = api.activeGroup;
  const panel = api.addPanel({
    id: desc.id,
    component: desc.type,
    tabComponent: desc.type,
    title: desc.title,
    // `type` is embedded so panels self-describe (used by teardown / restore).
    params: { ...desc.params, type: desc.type },
    ...(active && desc.index !== undefined
      ? { position: { referenceGroup: active.id, index: desc.index } }
      : {}),
  });
  panel.api.setActive();
}

/** Open a subject stream in the editor area, reusing an existing tab. */
export async function openStream(connId: string, subject: string) {
  if (!api) return; // never subscribe without a UI surface to host the tab
  const id = streamEditorId(connId, subject);
  if (!useStream.getState().sessions[id]) {
    await useStream.getState().open(id, connId, subject);
  }
  openEditor({
    type: "stream",
    id,
    title: subject,
    params: { streamId: id, connId, subject },
  });
}

/** Open a server-info tab for a connection. */
export function openServerInfo(connId: string) {
  openEditor({
    type: "server",
    id: serverEditorId(connId),
    title: connId,
    params: { connId },
  });
}

/** Open settings as the first editor tab. */
export function openSettings() {
  openEditor({ type: "settings", id: "settings", title: "Settings", index: 0 });
}

/** Close every conn-scoped editor tab when a connection drops. */
export function closeEditorsForConn(connId: string) {
  if (!api) {
    // No UI surface: tear down the only store-backed editors (streams).
    const { sessions, close } = useStream.getState();
    for (const s of Object.values(sessions)) {
      if (s.connId === connId) void close(s.id);
    }
    return;
  }

  for (const panel of api.panels) {
    const p = panel.params as
      | { type?: EditorType; connId?: string }
      | undefined;
    if (!p?.type) continue;
    const def = EDITORS[p.type];
    if (def.connScoped && p.connId === connId) {
      // dispose() releases the subscription; it is idempotent, so the
      // onDidRemovePanel handler firing on close() is a harmless no-op.
      def.dispose?.(panel.id);
      panel.api.close();
    }
  }
}
