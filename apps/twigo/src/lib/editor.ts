import type { DockviewApi } from "dockview-react";
import { useStream } from "@/store/stream";
import { useResponder } from "@/store/responder";
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
  replaceParams?: boolean;
}

let api: DockviewApi | null = null;

export function setEditorApi(value: DockviewApi) {
  api = value;
}

// Set while the Dockview layout is being swapped (context switch) or torn down
// (connection loss), so EditorArea's listeners don't treat bulk panel removals
// as user closes (tearing down live streams) or persist an empty layout.
let replacingLayout = false;
export function isReplacingLayout(): boolean {
  return replacingLayout;
}
export function setReplacingLayout(value: boolean): void {
  replacingLayout = value;
}

// Encode the components: ':' is the delimiter but is legal in both NATS
// subjects and context names, so raw interpolation could collide.
function streamEditorId(connId: string, subject: string): string {
  return `stream:${encodeURIComponent(connId)}:${encodeURIComponent(subject)}`;
}

function serverEditorId(connId: string): string {
  return `server:${encodeURIComponent(connId)}`;
}

function publishEditorId(connId: string): string {
  return `publish:${encodeURIComponent(connId)}`;
}

function responderEditorId(connId: string, key: string): string {
  return `responder:${encodeURIComponent(connId)}:${encodeURIComponent(key)}`;
}

function openEditor(desc: EditorDescriptor): void {
  if (!api) return;

  const existing = api.getPanel(desc.id);
  if (existing) {
    if (desc.replaceParams) {
      existing.api.updateParameters({ ...desc.params, type: desc.type });
    }
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

// Bumped on every prefilled open so the form remounts with the new values
// (e.g. republishing a different message into an already-open Publish tab).
let publishSeed = 0;

/** Open a publish/request tab for a connection, optionally prefilling subject, payload & headers. */
export function openPublish(
  connId: string,
  subject?: string,
  payload?: string,
  headers?: [string, string][],
) {
  const hasPrefill = Boolean(
    (subject ?? "") || (payload ?? "") || headers?.length,
  );
  if (hasPrefill) publishSeed += 1;
  openEditor({
    type: "publish",
    id: publishEditorId(connId),
    title: `Publish · ${connId}`,
    params: {
      connId,
      subject: subject ?? "",
      payload: payload ?? "",
      headers: headers ?? [],
      seed: publishSeed,
    },
    replaceParams: hasPrefill,
  });
}

let responderSeed = 0;

/** Open an auto-responder/mock tab, optionally pre-targeting a subject. */
export function openResponder(connId: string, subject?: string) {
  const seeded = subject?.trim() ? subject : `new-${(responderSeed += 1)}`;
  const id = responderEditorId(connId, seeded);
  useResponder.getState().ensure(id, connId, subject ?? "");
  openEditor({
    type: "responder",
    id,
    title: subject?.trim() ? `Mock ${subject}` : "Responder",
    params: { id, connId, subject: subject ?? "" },
  });
}

/** Focus or reopen the editor tab for an existing responder session. */
export function openResponderTab(id: string, connId: string, subject: string) {
  openEditor({
    type: "responder",
    id,
    title: subject.trim() ? `Mock ${subject}` : "Responder",
    params: { id, connId, subject },
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

function jsStreamEditorId(connId: string, stream: string): string {
  return `jsstream:${encodeURIComponent(connId)}:${encodeURIComponent(stream)}`;
}

function jsConsumerEditorId(
  connId: string,
  stream: string,
  consumer: string,
): string {
  return `jsconsumer:${encodeURIComponent(connId)}:${encodeURIComponent(stream)}:${encodeURIComponent(consumer)}`;
}

/** Open a JetStream stream detail tab, reusing an existing tab. */
export function openStreamDetail(connId: string, stream: string) {
  openEditor({
    type: "jsstream",
    id: jsStreamEditorId(connId, stream),
    title: stream,
    params: { connId, stream },
  });
}

/** Open a JetStream consumer detail tab, reusing an existing tab. */
export function openConsumerDetail(
  connId: string,
  stream: string,
  consumer: string,
) {
  openEditor({
    type: "jsconsumer",
    id: jsConsumerEditorId(connId, stream, consumer),
    title: consumer,
    params: { connId, stream, consumer },
  });
}

/** Close a stream/consumer detail tab (e.g. after the entity is deleted). */
export function closeStreamDetail(connId: string, stream: string) {
  api?.getPanel(jsStreamEditorId(connId, stream))?.api.close();
}

export function closeConsumerDetail(
  connId: string,
  stream: string,
  consumer: string,
) {
  api?.getPanel(jsConsumerEditorId(connId, stream, consumer))?.api.close();
}

function kvEntryEditorId(connId: string, bucket: string, key: string): string {
  return `kventry:${encodeURIComponent(connId)}:${encodeURIComponent(bucket)}:${encodeURIComponent(key)}`;
}

/** Open a KV entry detail tab, reusing an existing tab. */
export function openKvEntry(connId: string, bucket: string, key: string) {
  openEditor({
    type: "kventry",
    id: kvEntryEditorId(connId, bucket, key),
    title: key,
    params: { connId, bucket, key },
  });
}

/** Open settings as the first editor tab. */
export function openSettings() {
  openEditor({ type: "settings", id: "settings", title: "Settings", index: 0 });
}

/** Tear down a connection's editors + live sessions when it drops. */
export function closeEditorsForConn(connId: string) {
  setReplacingLayout(true);
  try {
    // Responders and streams are tab-independent (they persist across context
    // switches), so tear down this connection's sessions from the stores —
    // including ones whose tabs aren't in the currently shown layout.
    useResponder.getState().removeConn(connId);
    const { sessions, close } = useStream.getState();
    for (const s of Object.values(sessions)) {
      if (s.connId === connId) void close(s.id);
    }
    // Close this connection's panels in the shown layout (its persisted layout
    // is preserved — the save is suppressed while replacingLayout is set).
    if (api) {
      for (const panel of api.panels) {
        const p = panel.params as
          | { type?: EditorType; connId?: string }
          | undefined;
        if (p?.type && EDITORS[p.type].connScoped && p.connId === connId) {
          panel.api.close();
        }
      }
    }
  } finally {
    setReplacingLayout(false);
  }
}
