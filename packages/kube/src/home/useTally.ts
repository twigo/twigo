import { useEffect } from "react";
import type { Gvr, ListQuery, Resource, ValueCount } from "@twigo/protocol";
import { useWorkbench } from "@twigo/workbench";
import type { Loaded } from "../discovery";
import { SHOWS_ROWS } from "../list/listStatus";
import { useListView } from "../list/useListView";
import { viewProblem } from "../viewProblem";

/** A list as the cluster's home counts it, or why it could not. */
export type Tally =
  | { readonly state: "loading" }
  | { readonly state: "missing"; readonly why: string }
  | {
      readonly state: "counted";
      readonly resource: Resource;
      readonly total: number;
      readonly counts: readonly ValueCount[];
    };

/**
 * A list's rows and their counts by a column, as Rust's query view takes
 * them (ARCHITECTURE 3.4): the window stays empty, so no row crosses the
 * IPC. A list the credentials may not read is missing, never 0.
 */
export function useTally(
  space: string,
  resources: Loaded<readonly Resource[]>,
  gvr: Gvr,
  countBy: string | undefined,
  namespaces: readonly string[],
): Tally {
  const { backend } = useWorkbench();
  const resource =
    resources.state === "ready"
      ? resources.value.find(
          (candidate) =>
            candidate.gvr.group === gvr.group &&
            candidate.gvr.resource === gvr.resource,
        )
      : undefined;
  const query: ListQuery | undefined = resource && {
    space,
    gvr: resource.gvr,
    namespaced: resource.namespaced,
    namespaces: [...namespaces],
    labelSelector: null,
    text: null,
    columns: null,
    sort: null,
    countBy: countBy ?? null,
    groupBy: null,
    values: null,
  };
  const { snapshot, setWindow } = useListView(backend, query);
  useEffect(() => {
    setWindow(0, 0);
  }, [setWindow]);

  const what = gvr.group ? `${gvr.resource}.${gvr.group}` : gvr.resource;
  if (resources.state === "failed")
    return { state: "missing", why: resources.error.message };
  if (resources.state === "loading") return { state: "loading" };
  if (!resource)
    return { state: "missing", why: `The cluster does not serve ${what}.` };
  if (SHOWS_ROWS.has(snapshot.status.state))
    return {
      state: "counted",
      resource,
      total: snapshot.total,
      counts: snapshot.counts,
    };
  const problem = viewProblem(snapshot.status, what);
  return problem
    ? { state: "missing", why: problem.body }
    : { state: "loading" };
}
