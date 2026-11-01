import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Column, Row, ViewState } from "@twigo/protocol";
import { useChanges, useWorkbench, type EditorProps } from "@twigo/workbench";
import { Details } from "./Details";
import { sameGvr, useResources, type Discovery } from "./discovery";
import { pluralTitle } from "./kinds";
import type { ListStatuses } from "./listStatus";
import type { Lists } from "./lists";
import { ResourceTable, type ListController } from "./ResourceTable";
import type { Selection } from "./selection";
import { parseListUri } from "./uri";

export interface ListServices {
  readonly discovery: Discovery;
  readonly lists: Lists;
  readonly selection: Selection;
  readonly statuses: ListStatuses;
}

/**
 * A `k8s-list://` editor. Without `ns` in its URI it follows the space's
 * namespace scope; its grid scopes `listFocus` and the resource keys. An
 * opened row's details slide in over the list.
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
  const { lists, selection, statuses } = services;
  useEffect(
    () => () => {
      statuses.set(uri, undefined);
    },
    [statuses, uri],
  );
  useChanges(selection.changes);
  const title = resource
    ? pluralTitle(resource.kind, resource.gvr.resource)
    : undefined;
  useEffect(() => {
    if (title) editors.setTitle(uri, title);
  }, [editors, uri, title]);

  const remembered = input && selection.get(input.space);
  const mine =
    remembered && sameGvr(remembered.gvr, input.gvr) ? remembered : undefined;
  const [open, setOpen] = useState(mine?.reveal === true);
  const table = useRef<ListController>(undefined);
  const [wrapper, setWrapper] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!wrapper) return;
    const scope = keys.scope(wrapper);
    scope.set("detailsOpen", open);
    const unregister = lists.register(wrapper, {
      move: (delta) => table.current?.move(delta),
      moveToEdge: (edge) => table.current?.moveToEdge(edge),
      activate: () => table.current?.activate(),
      closeDetails: () => {
        setOpen(false);
      },
    });
    return () => {
      unregister();
      scope.dispose();
    };
  }, [wrapper, keys, lists, open]);

  const register = useCallback(
    (grid: HTMLElement, list: ListController) => {
      table.current = list;
      const scope = keys.scope(grid);
      scope.set("listFocus", true);
      if (resource) {
        scope.set("resource.group", resource.gvr.group);
        scope.set("resource.kind", resource.kind);
        scope.set("resource.namespaced", resource.namespaced);
      }
      return () => {
        scope.dispose();
      };
    },
    [keys, resource],
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

  const onStatus = useCallback(
    (total: number, status: ViewState) => {
      statuses.set(uri, { title: title ?? uri, total, status });
    },
    [statuses, uri, title],
  );

  if (!input) return null;
  const namespaces = input.namespaces ?? spaces.state(input.space).namespaces;
  return (
    <div ref={setWrapper} className="relative h-full overflow-hidden">
      <ResourceTable
        backend={backend}
        space={input.space}
        gvr={input.gvr}
        title={title ?? input.gvr.resource}
        namespaces={namespaces}
        text={input.text}
        labelSelector={input.labels}
        initialSelected={mine?.row.id}
        onSelect={onSelect}
        onActivate={() => {
          setOpen(true);
        }}
        onStatus={onStatus}
        register={register}
      />
      {open && mine && (
        <Details
          selected={mine}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}
