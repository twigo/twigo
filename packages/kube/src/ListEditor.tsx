import { useCallback, useEffect, useMemo } from "react";
import type { Column, Row } from "@twigo/protocol";
import { useChanges, useWorkbench, type EditorProps } from "@twigo/workbench";
import { sameGvr, useResources, type Discovery } from "./discovery";
import { pluralTitle } from "./kinds";
import type { Lists } from "./lists";
import { ResourceTable, type ListController } from "./ResourceTable";
import type { Selection } from "./selection";
import { parseListUri } from "./uri";

export interface ListServices {
  readonly discovery: Discovery;
  readonly lists: Lists;
  readonly selection: Selection;
}

/**
 * A `k8s-list://` editor. Without `ns` in its URI it follows the space's
 * namespace scope; its grid scopes `listFocus` and the resource keys.
 */
export function ListEditor({
  uri,
  services,
}: EditorProps & { services: ListServices }) {
  const { backend, keys, spaces, editors } = useWorkbench();
  useChanges(spaces.changes);
  const input = useMemo(() => parseListUri(uri), [uri]);
  const resources = useResources(services.discovery, input?.space ?? "");
  const resource =
    input && resources.state === "ready"
      ? resources.value.find((candidate) => sameGvr(candidate.gvr, input.gvr))
      : undefined;
  const { lists, selection } = services;
  const title = resource
    ? pluralTitle(resource.kind, resource.gvr.resource)
    : undefined;
  useEffect(() => {
    if (title) editors.setTitle(uri, title);
  }, [editors, uri, title]);

  const register = useCallback(
    (grid: HTMLElement, list: ListController) => {
      const scope = keys.scope(grid);
      scope.set("listFocus", true);
      if (resource) {
        scope.set("resource.group", resource.gvr.group);
        scope.set("resource.kind", resource.kind);
        scope.set("resource.namespaced", resource.namespaced);
      }
      const unregister = lists.register(grid, list);
      return () => {
        unregister();
        scope.dispose();
      };
    },
    [keys, lists, resource],
  );

  const onSelect = useCallback(
    (row: Row, columns: readonly Column[]) => {
      if (!input) return;
      selection.set({
        space: input.space,
        gvr: input.gvr,
        kind: resource?.kind ?? input.gvr.resource,
        columns,
        row,
      });
    },
    [input, resource, selection],
  );

  if (!input) return null;
  const namespaces = input.namespaces ?? spaces.state(input.space).namespaces;
  const remembered = selection.get(input.space);
  return (
    <ResourceTable
      backend={backend}
      space={input.space}
      gvr={input.gvr}
      title={title ?? input.gvr.resource}
      namespaces={namespaces}
      text={input.text}
      labelSelector={input.labels}
      initialSelected={
        remembered && sameGvr(remembered.gvr, input.gvr)
          ? remembered.row.id
          : undefined
      }
      onSelect={onSelect}
      register={register}
    />
  );
}
