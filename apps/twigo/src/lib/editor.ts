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

/** Open a subject stream in the editor area, reusing an existing tab. */
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
  open("publish", {
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

/** Open a server-info tab for a connection. */
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

/** Open a JetStream stream detail tab, reusing an existing tab. */
export function openStreamDetail(connId: string, stream: string) {
  open("jsstream", {
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
  open("jsconsumer", {
    id: jsConsumerEditorId(connId, stream, consumer),
    title: consumer,
    params: { connId, stream, consumer },
  });
}

/** Close a stream/consumer detail tab (e.g. after the entity is deleted). */
export function closeStreamDetail(connId: string, stream: string) {
  closePanel(jsStreamEditorId(connId, stream));
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

/** Open a KV entry detail tab, reusing an existing tab. */
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

/** Open an Object Store object detail tab, reusing an existing tab. */
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

/** Open the wide Server-health tab (connections table) for a connection. */
export function openServerHealth(connId: string) {
  open("serverhealth", {
    id: `serverhealth:${encodeURIComponent(connId)}`,
    title: "Server health",
    params: { connId },
  });
}

/** Tear down a connection's editors + live sessions when it drops. */
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
        | { type?: EditorType; connId?: string }
        | undefined;
      if (p?.type && EDITORS[p.type].connScoped && p.connId === connId) {
        closePanel(panel.id);
      }
    }
  });
}
