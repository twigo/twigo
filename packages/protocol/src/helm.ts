import type { Gvr, ListQuery, ReleaseListQuery } from "./generated";

/**
 * The resource the webview's list machinery stands Helm releases in for: its
 * column rules, presets and icon are keyed by it, and a list of it is
 * subscribed with `helm_list_subscribe` (ARCHITECTURE 4.4).
 */
export const HELM_RELEASES: Gvr = {
  group: "helm.sh",
  version: "v1",
  resource: "releases",
};

export function isHelmList(gvr: Gvr): boolean {
  return gvr.group === HELM_RELEASES.group && gvr.resource === "releases";
}

/** What `helm_list_subscribe` takes of a list's query: the releases of its namespaces, which have no selectors of their own. */
export function releaseListQuery(query: ListQuery): ReleaseListQuery {
  return {
    space: query.space,
    namespaces: query.namespaces,
    text: query.text,
    columns: query.columns,
    sort: query.sort,
    countBy: query.countBy,
    groupBy: query.groupBy,
    values: query.values,
  };
}
