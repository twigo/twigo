import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert } from "lucide-react";
import type { Column, GroupCount, Row, ViewState } from "@twigo/protocol";
import { EmptyState } from "@twigo/ui";
import { useChanges, useWorkbench, type EditorProps } from "@twigo/workbench";
import { Details } from "./Details";
import type { ColumnPresets } from "./columnPresets";
import type { ListFilters } from "./filters";
import { byHealth, healthValues } from "./health";
import { sameGvr, useResources, type Discovery } from "./discovery";
import { pluralTitle } from "./kinds";
import { SHOWS_ROWS, type ListStatuses } from "./listStatus";
import type { Lists } from "./lists";
import {
  ResourceTable,
  type ListController,
  type RowAction,
} from "./ResourceTable";
import type { Selection } from "./selection";
import { statusColumn } from "./tones";
import { parseListUri } from "./uri";

export interface ListServices {
  readonly discovery: Discovery;
  readonly lists: Lists;
  readonly filters: ListFilters;
  readonly columns: ColumnPresets;
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
  const { backend, keys, spaces, editors, menus, commands, keybindings } =
    useWorkbench();
  useChanges(spaces.changes);
  const input = useMemo(() => parseListUri(uri), [uri]);
  const resources = useResources(services.discovery, input?.space ?? "");
  // Discovery names each group's preferred version; a list of another
  // version that the cluster serves has the same kind and scope.
  const resource =
    input && resources.state === "ready"
      ? (resources.value.find((candidate) =>
          sameGvr(candidate.gvr, input.gvr),
        ) ??
        resources.value.find(
          (candidate) =>
            candidate.gvr.group === input.gvr.group &&
            candidate.gvr.resource === input.gvr.resource,
        ))
      : undefined;
  const { lists, selection, statuses, filters, columns } = services;
  useChanges(filters.changes);
  useChanges(statuses.changes);
  useChanges(columns.changes);
  useChanges(menus.changes);
  useChanges(keybindings.changes);
  const [grid, setGrid] = useState<HTMLElement | null>(null);
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

  const mine = selection.get(uri);
  const [open, setOpen] = useState(mine?.reveal === true);
  const [revealed, setRevealed] = useState(mine);
  if (mine !== revealed) {
    setRevealed(mine);
    if (mine?.reveal) setOpen(true);
  }
  const table = useRef<ListController>(undefined);
  const [wrapper, setWrapper] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!wrapper) return;
    const scope = keys.scope(wrapper);
    scope.set("detailsOpen", open);
    const unregister = lists.register(
      wrapper,
      {
        move: (delta) => table.current?.move(delta),
        moveToEdge: (edge) => table.current?.moveToEdge(edge),
        activate: () => table.current?.activate(),
        closeDetails: () => {
          setOpen(false);
        },
        filter: () => {
          filters.focus(uri);
        },
      },
      uri,
    );
    return () => {
      unregister();
      scope.dispose();
    };
  }, [wrapper, keys, lists, open, filters, uri]);

  const register = useCallback(
    (element: HTMLElement, list: ListController) => {
      table.current = list;
      setGrid(element);
      const scope = keys.scope(element);
      scope.set("listFocus", true);
      if (resource) {
        scope.set("resource.group", resource.gvr.group);
        scope.set("resource.kind", resource.kind);
        scope.set("resource.namespaced", resource.namespaced);
      }
      return () => {
        setGrid(null);
        scope.dispose();
      };
    },
    [keys, resource, setGrid],
  );

  const onSelect = useCallback(
    (row: Row, columns: readonly Column[]) => {
      if (!input) return;
      selection.set(uri, {
        gvr: input.gvr,
        kind: resource?.kind ?? input.gvr.resource,
        columns,
        row,
      });
    },
    [input, resource, selection, uri],
  );

  const column = input && statusColumn(input.gvr);
  const onStatus = useCallback(
    (total: number, status: ViewState, groups: readonly GroupCount[]) => {
      statuses.set(uri, { title: title ?? uri, total, status, groups });
      const picked = filters.health(uri);
      if (input && column && picked && SHOWS_ROWS.has(status.state)) {
        const counts = byHealth(input.gvr, column, groups);
        filters.setHealth(uri, {
          health: picked.health,
          values: healthValues(counts[picked.health]),
        });
      }
    },
    [statuses, filters, input, column, uri, title],
  );

  if (!input) return null;
  const { group, resource: plural } = input.gvr;
  const named = group ? `${plural}.${group}` : plural;
  if (resources.state === "failed") {
    return (
      <EmptyState
        icon={CircleAlert}
        variant="error"
        title={`Could not load ${named}`}
        className="h-full"
      >
        <p className="max-w-md text-muted-foreground">
          {resources.error.message}
        </p>
      </EmptyState>
    );
  }
  if (resources.state === "ready" && !resource) {
    return (
      <EmptyState
        icon={CircleAlert}
        title={`The cluster does not serve ${named}`}
        className="h-full"
      />
    );
  }
  const namespaces = input.namespaces ?? spaces.state(input.space).namespaces;
  const text = filters.text(uri) ?? input.text;
  const lookup = keys.lookup(grid);
  const rowActions = menus
    .groups("resource/context", lookup)
    .map((group) =>
      group.flatMap((item): RowAction[] => {
        const command = commands.get(item.command);
        if (!command) return [];
        const binding = keybindings.primary(item.command);
        return [
          {
            id: item.command,
            label: command.title,
            ...(binding && { keys: keybindings.label(binding.presses) }),
            run: () => {
              void commands.execute(item.command, lookup);
            },
          },
        ];
      }),
    )
    .filter((group) => group.length > 0);
  const health = filters.health(uri);
  const values =
    column && health ? { column, values: [...health.values] } : undefined;
  return (
    <div ref={setWrapper} className="relative h-full overflow-hidden">
      <ResourceTable
        backend={backend}
        space={input.space}
        gvr={input.gvr}
        namespaced={resource?.namespaced}
        title={title ?? input.gvr.resource}
        namespaces={namespaces}
        text={text === "" ? undefined : text}
        values={values}
        choices={columns.choices(input.gvr)}
        onChoose={(column, shown) => {
          columns.choose(input.gvr, column, shown);
        }}
        rowActions={rowActions}
        labelSelector={input.labels}
        onClearFilters={() => {
          filters.setText(uri, "");
          filters.setHealth(uri, undefined);
        }}
        selectedId={mine?.row.id}
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
