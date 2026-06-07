import type { DockviewApi } from "dockview-react";
import { useStream } from "@/store/stream";

// Editor "inputs" (VS Code model): a type + a stable id. Opening the same id
// focuses the existing tab instead of duplicating it.
export type EditorType = "stream" | "settings" | "server";

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
    params: desc.params ?? {},
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
  openEditor({ type: "stream", id, title: subject, params: { streamId: id } });
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

/** Close every editor tab bound to a connection (e.g. on disconnect). */
export function closeEditorsForConn(connId: string) {
  const { sessions, close } = useStream.getState();

  for (const session of Object.values(sessions)) {
    if (session.connId !== connId) continue;
    // Close the tab and tear down the subscription explicitly. close() is
    // idempotent, so the onDidRemovePanel handler firing afterwards is a no-op.
    api?.getPanel(session.id)?.api.close();
    void close(session.id);
  }

  api?.getPanel(serverEditorId(connId))?.api.close();
}
