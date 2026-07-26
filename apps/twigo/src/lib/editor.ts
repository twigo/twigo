import {
  openPanel,
  closePanel,
  listPanels,
  hasEditorApi,
  withReplacingLayout,
  type PanelDescriptor,
} from "@/shell/editorHost";
import { useStream } from "@/store/stream";
import { useResponder } from "@/store/responder";
import { EDITORS, type EditorType } from "@/components/editor/registry";

// NATS editor opens: typed wrappers over the shell's generic openPanel. An
// "input" is a type + a stable id, so opening the same id focuses the existing
// tab instead of duplicating it. The shell host (src/shell/editorHost) owns the
// Dockview api and the generic pane ops; this module owns only the NATS-shaped
// opens and the per-connection teardown.

// Typed open: keeps editor-type exhaustiveness here in the domain while the
// shell's openPanel stays a plain string-keyed primitive.
function open(
  type: EditorType,
  desc: Omit<PanelDescriptor, "component">,
): void {
  openPanel({ ...desc, component: type });
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

export async function openStream(connId: string, subject: string) {
  if (!hasEditorApi()) return; // never subscribe without a UI surface to host the tab
  const id = streamEditorId(connId, subject);
  if (!useStream.getState().sessions[id]) {
    await useStream.getState().open(id, connId, subject);
  }
  open("stream", {
    id,
    title: subject,
    params: { streamId: id, connId, subject },
  });
}

// Bumped on every prefilled open so the form remounts with the new values
// (e.g. republishing a different message into an already-open Publish tab).
let publishSeed = 0;

export function openPublish(
  connId: string,
  subject?: string,
  payload?: string,
  headers?: [string, string][],
  payloadB64?: string,
) {
  const hasPrefill = Boolean(
    (subject ?? "") || (payload ?? "") || (payloadB64 ?? "") || headers?.length,
  );
  if (hasPrefill) publishSeed += 1;
  open("publish", {
    id: publishEditorId(connId),
    title: `Publish · ${connId}`,
    params: {
      connId,
      subject: subject ?? "",
      payload: payload ?? "",
      payloadB64: payloadB64 ?? "",
      headers: headers ?? [],
      seed: publishSeed,
    },
    replaceParams: hasPrefill,
  });
}

let responderSeed = 0;

export function openResponder(connId: string, subject?: string) {
  const seeded = subject?.trim() ? subject : `new-${(responderSeed += 1)}`;
  const id = responderEditorId(connId, seeded);
  useResponder.getState().ensure(id, connId, subject ?? "");
  open("responder", {
    id,
    title: subject?.trim() ? `Mock ${subject}` : "Responder",
    params: { id, connId, subject: subject ?? "" },
  });
}

/** Focus or reopen the editor tab for an existing responder session. */
export function openResponderTab(id: string, connId: string, subject: string) {
  open("responder", {
    id,
    title: subject.trim() ? `Mock ${subject}` : "Responder",
    params: { id, connId, subject },
  });
}

export function openServerInfo(connId: string) {
  open("server", {
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

export function openStreamDetail(connId: string, stream: string) {
  open("jsstream", {
    id: jsStreamEditorId(connId, stream),
    title: stream,
    params: { connId, stream },
  });
}

export function openConsumerDetail(
  connId: string,
  stream: string,
  consumer: string,
) {
  open("jsconsumer", {
    id: jsConsumerEditorId(connId, stream, consumer),
    title: consumer,
    params: { connId, stream, consumer },
  });
}

export function closeStreamDetail(connId: string, stream: string) {
  closePanel(jsStreamEditorId(connId, stream));
  closePanel(jsBrowseEditorId(connId, stream));
}

function jsBrowseEditorId(connId: string, stream: string): string {
  return `jsbrowse:${encodeURIComponent(connId)}:${encodeURIComponent(stream)}`;
}

export function openStreamBrowse(connId: string, stream: string) {
  open("jsbrowse", {
    id: jsBrowseEditorId(connId, stream),
    title: `${stream} · messages`,
    params: { connId, stream },
  });
}

export function closeConsumerDetail(
  connId: string,
  stream: string,
  consumer: string,
) {
  closePanel(jsConsumerEditorId(connId, stream, consumer));
}

function kvEntryEditorId(connId: string, bucket: string, key: string): string {
  return `kventry:${encodeURIComponent(connId)}:${encodeURIComponent(bucket)}:${encodeURIComponent(key)}`;
}

export function openKvEntry(connId: string, bucket: string, key: string) {
  open("kventry", {
    id: kvEntryEditorId(connId, bucket, key),
    title: key,
    params: { connId, bucket, key },
  });
}

export function closeKvEntry(connId: string, bucket: string, key: string) {
  closePanel(kvEntryEditorId(connId, bucket, key));
}

function objEntryEditorId(
  connId: string,
  bucket: string,
  name: string,
): string {
  return `objentry:${encodeURIComponent(connId)}:${encodeURIComponent(bucket)}:${encodeURIComponent(name)}`;
}

export function openObjectEntry(connId: string, bucket: string, name: string) {
  open("objentry", {
    id: objEntryEditorId(connId, bucket, name),
    title: name,
    params: { connId, bucket, name },
  });
}

export function closeObjectEntry(connId: string, bucket: string, name: string) {
  closePanel(objEntryEditorId(connId, bucket, name));
}

function serviceEditorId(connId: string, name: string, id: string): string {
  return `service:${encodeURIComponent(connId)}:${encodeURIComponent(name)}:${encodeURIComponent(id)}`;
}

export function openService(connId: string, name: string, id: string) {
  open("service", {
    id: serviceEditorId(connId, name, id),
    title: name,
    params: { connId, name, id },
  });
}

export function openServerHealth(connId: string) {
  open("serverhealth", {
    id: `serverhealth:${encodeURIComponent(connId)}`,
    title: "Server health",
    params: { connId },
  });
}

export function closeEditorsForConn(connId: string) {
  withReplacingLayout(() => {
    // Responders and streams are tab-independent (they persist across context
    // switches), so tear down this connection's sessions from the stores -
    // including ones whose tabs aren't in the currently shown layout.
    useResponder.getState().removeConn(connId);
    const { sessions, close } = useStream.getState();
    for (const s of Object.values(sessions)) {
      if (s.connId === connId) void close(s.id);
    }
    // Close this connection's panels in the shown layout. Per-tab dispose
    // (onDidRemovePanel) is suppressed while replacingLayout is set, so the
    // store teardown above is the authoritative path here.
    for (const panel of listPanels()) {
      const p = panel.params as
        { type?: EditorType; connId?: string } | undefined;
      if (p?.type && EDITORS[p.type].connScoped && p.connId === connId) {
        closePanel(panel.id);
      }
    }
  });
}
