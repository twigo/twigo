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
