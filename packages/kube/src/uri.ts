import type { Gvr } from "@twigo/protocol";

/**
 * A resource table as an editor (ARCHITECTURE 4.3):
 * `k8s-list://<space>/[<group>/]<version>/<resource>?ns=a,b&q=text&l=selector`.
 * Without `ns` the table follows the space's namespace scope.
 */
export interface ListInput {
  readonly space: string;
  readonly gvr: Gvr;
  readonly namespaces?: readonly string[];
  readonly text?: string;
  readonly labels?: string;
}

export const LIST_SCHEME = "k8s-list";

export function listUri({
  space,
  gvr,
  namespaces,
  text,
  labels,
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
  return {
    space: decodeURIComponent(url.host),
    gvr: { group, version, resource },
    ...(ns && { namespaces: ns.split(",").filter(Boolean) }),
    ...(text && { text }),
    ...(labels && { labels }),
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
