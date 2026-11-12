import type { ForwardId, Gvr, LogTarget } from "@twigo/protocol";
import type { Health } from "./columns";

/**
 * A resource table as an editor (ARCHITECTURE 4.3):
 * `k8s-list://<space>/[<group>/]<version>/<resource>?ns=a,b&q=text&l=selector&h=error`.
 * Without `ns` the table follows the space's namespace scope; `q` and `h`
 * are the filters it opens with.
 */
export interface ListInput {
  readonly space: string;
  readonly gvr: Gvr;
  readonly namespaces?: readonly string[];
  readonly text?: string;
  readonly labels?: string;
  readonly health?: Health;
}

const HEALTHS: readonly Health[] = ["ok", "warn", "error"];

export const LIST_SCHEME = "k8s-list";

export function listUri({
  space,
  gvr,
  namespaces,
  text,
  labels,
  health,
}: ListInput): string {
  const path = [gvr.group, gvr.version, gvr.resource]
    .filter((part) => part !== "")
    .map(encodeURIComponent)
    .join("/");
  const query = new URLSearchParams();
  if (namespaces && namespaces.length > 0)
    query.set("ns", namespaces.join(","));
  if (text) query.set("q", text);
  if (labels) query.set("l", labels);
  if (health) query.set("h", health);
  const search = query.toString();
  return `${LIST_SCHEME}://${encodeURIComponent(space)}/${path}${search ? `?${search}` : ""}`;
}

export function parseListUri(uri: string): ListInput | undefined {
  const url = new URL(uri);
  if (url.protocol !== `${LIST_SCHEME}:`) return undefined;
  const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
  const [group, version, resource] =
    parts.length === 2 ? ["", ...parts] : parts.length === 3 ? parts : [];
  if (group === undefined || !version || !resource) return undefined;
  const ns = url.searchParams.get("ns");
  const text = url.searchParams.get("q");
  const labels = url.searchParams.get("l");
  const health = HEALTHS.find((h) => h === url.searchParams.get("h"));
  return {
    space: decodeURIComponent(url.host),
    gvr: { group, version, resource },
    ...(ns && { namespaces: ns.split(",").filter(Boolean) }),
    ...(text && { text }),
    ...(labels && { labels }),
    ...(health && { health }),
  };
}

/**
 * One object as an editor (ARCHITECTURE 4.3):
 * `k8s://<space>/<group>/<version>/<resource>[/<namespace>]/<name>`, the core
 * group an empty segment, so the path has five segments for an object in a
 * namespace and four for a cluster-scoped one.
 */
export interface ObjectInput {
  readonly space: string;
  readonly gvr: Gvr;
  readonly namespace?: string;
  readonly name: string;
}

export const OBJECT_SCHEME = "k8s";

export function objectUri({
  space,
  gvr,
  namespace,
  name,
}: ObjectInput): string {
  const path = [
    gvr.group,
    gvr.version,
    gvr.resource,
    ...(namespace === undefined ? [] : [namespace]),
    name,
  ]
    .map(encodeURIComponent)
    .join("/");
  return `${OBJECT_SCHEME}://${encodeURIComponent(space)}/${path}`;
}

export function parseObjectUri(uri: string): ObjectInput | undefined {
  const url = new URL(uri);
  if (url.protocol !== `${OBJECT_SCHEME}:`) return undefined;
  const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
  if (parts.length !== 4 && parts.length !== 5) return undefined;
  const [group = "", version = "", resource = ""] = parts;
  const name = parts[parts.length - 1] ?? "";
  if (!version || !resource || !name) return undefined;
  return {
    space: decodeURIComponent(url.host),
    gvr: { group, version, resource },
    ...(parts.length === 5 && { namespace: parts[3] }),
    name,
  };
}

export const LOGS_SCHEME = "logs";

/**
 * A logs tab in the panel (ARCHITECTURE 4.3, 4.6), which follows a pod or
 * a workload's pods: `logs://<space>/<group>/<version>/<resource>/<namespace>/<name>`,
 * the core group an empty segment, as in an object's URI.
 */
export function logsUri({ space, gvr, namespace, name }: LogTarget): string {
  const path = [gvr.group, gvr.version, gvr.resource, namespace, name]
    .map(encodeURIComponent)
    .join("/");
  return `${LOGS_SCHEME}://${encodeURIComponent(space)}/${path}`;
}

export function parseLogsUri(uri: string): LogTarget | undefined {
  const url = new URL(uri);
  if (url.protocol !== `${LOGS_SCHEME}:`) return undefined;
  const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
  if (parts.length !== 5) return undefined;
  const [group = "", version = "", resource = "", namespace = "", name = ""] =
    parts;
  if (!version || !resource || !namespace || !name) return undefined;
  return {
    space: decodeURIComponent(url.host),
    gvr: { group, version, resource },
    namespace,
    name,
  };
}

export const EXEC_SCHEME = "exec";

/**
 * A shell or an attach in a container, a tab of the panel (ARCHITECTURE 4.3,
 * 4.6): `exec://<space>/<namespace>/<pod>/<container>`, `?n=2` for a second
 * shell on the same container, `?attach=1` for one that joins its main
 * process.
 */
export interface ExecInput {
  readonly space: string;
  readonly namespace: string;
  readonly pod: string;
  readonly container: string;
  /** Which shell on the container: absent for the first, 2 and up for the others. */
  readonly n?: number;
  readonly attach?: boolean;
}

export function execUri({
  space,
  namespace,
  pod,
  container,
  n,
  attach,
}: ExecInput): string {
  const path = [namespace, pod, container].map(encodeURIComponent).join("/");
  const query = new URLSearchParams();
  if (n !== undefined) query.set("n", String(n));
  if (attach === true) query.set("attach", "1");
  const search = query.toString();
  return `${EXEC_SCHEME}://${encodeURIComponent(space)}/${path}${search ? `?${search}` : ""}`;
}

export function parseExecUri(uri: string): ExecInput | undefined {
  const url = new URL(uri);
  if (url.protocol !== `${EXEC_SCHEME}:`) return undefined;
  const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
  const [namespace = "", pod = "", container = ""] = parts;
  if (parts.length !== 3 || !namespace || !pod || !container) return undefined;
  const n = url.searchParams.get("n");
  return {
    space: decodeURIComponent(url.host),
    namespace,
    pod,
    container,
    ...(n !== null && /^([2-9]|[1-9]\d+)$/.test(n) && { n: Number(n) }),
    ...(url.searchParams.get("attach") === "1" && { attach: true }),
  };
}

export const PF_SCHEME = "pf";

/** A port-forward as an editor (ARCHITECTURE 4.3): `pf://<space>/<forward-id>`, the id the core gave it. */
export interface PfInput {
  readonly space: string;
  readonly id: ForwardId;
}

export function pfUri({ space, id }: PfInput): string {
  return `${PF_SCHEME}://${encodeURIComponent(space)}/${String(id)}`;
}

export function parsePfUri(uri: string): PfInput | undefined {
  const url = new URL(uri);
  if (url.protocol !== `${PF_SCHEME}:`) return undefined;
  const found = /^\/(0|[1-9]\d*)$/.exec(url.pathname);
  return found?.[1] === undefined || url.host === ""
    ? undefined
    : { space: decodeURIComponent(url.host), id: Number(found[1]) };
}

export const TERMINAL_SCHEME = "terminal";

/** A terminal on this machine, a tab of the panel (ARCHITECTURE 4.3, 4.6): `terminal://<space>/<n>`, numbered within its space. */
export interface TerminalInput {
  readonly space: string;
  readonly n: number;
}

export function terminalUri({ space, n }: TerminalInput): string {
  return `${TERMINAL_SCHEME}://${encodeURIComponent(space)}/${String(n)}`;
}

export function parseTerminalUri(uri: string): TerminalInput | undefined {
  const url = new URL(uri);
  if (url.protocol !== `${TERMINAL_SCHEME}:`) return undefined;
  const found = /^\/([1-9]\d*)$/.exec(url.pathname);
  return found?.[1] === undefined || url.host === ""
    ? undefined
    : { space: decodeURIComponent(url.host), n: Number(found[1]) };
}

export const UNTITLED_SCHEME = "untitled";

/** A new manifest and the space it was written in (ARCHITECTURE 4.3): `untitled://<space>/manifest-<n>`, the space encoded as an object's is. */
export interface ManifestInput {
  readonly space: string;
  readonly n: number;
}

export function untitledUri({ space, n }: ManifestInput): string {
  return `${UNTITLED_SCHEME}://${encodeURIComponent(space)}/manifest-${String(n)}`;
}

export function parseUntitledUri(uri: string): ManifestInput | undefined {
  const url = new URL(uri);
  if (url.protocol !== `${UNTITLED_SCHEME}:`) return undefined;
  const found = /^\/manifest-([1-9]\d*)$/.exec(url.pathname);
  return found?.[1] === undefined || url.host === ""
    ? undefined
    : { space: decodeURIComponent(url.host), n: Number(found[1]) };
}

export const DIFF_SCHEME = "diff";

/**
 * What a `diff://` editor compares (ARCHITECTURE 4.3): the dry-run of an
 * edit, an edit's opened object against the server's now, or any two
 * objects.
 */
export type DiffInput =
  | {
      readonly kind: "apply" | "server";
      /** The editor whose edit it is, an object's or a new manifest's. */
      readonly editor: string;
    }
  | {
      readonly kind: "objects";
      readonly space: string;
      readonly left: string;
      readonly right: string;
    };

export function diffUri(input: DiffInput): string {
  const query = new URLSearchParams(
    input.kind === "objects"
      ? { left: input.left, right: input.right }
      : { editor: input.editor },
  );
  const host = input.kind === "objects" ? input.space : "edit";
  return `${DIFF_SCHEME}://${encodeURIComponent(host)}/${input.kind}?${query.toString()}`;
}

export function parseDiffUri(uri: string): DiffInput | undefined {
  const url = new URL(uri);
  if (url.protocol !== `${DIFF_SCHEME}:`) return undefined;
  const kind = url.pathname.slice(1);
  const editor = url.searchParams.get("editor");
  if ((kind === "apply" || kind === "server") && editor) {
    return { kind, editor };
  }
  const left = url.searchParams.get("left");
  const right = url.searchParams.get("right");
  if (kind === "objects" && left && right) {
    return { kind, space: decodeURIComponent(url.host), left, right };
  }
  return undefined;
}
