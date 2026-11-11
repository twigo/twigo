import { useCallback } from "react";
import { ArrowLeftRight } from "lucide-react";
import type { Forward } from "@twigo/protocol";
import {
  DataGrid,
  EmptyState,
  StatusLabel,
  type GridColumn,
  type GridItem,
  type GridSort,
} from "@twigo/ui";
import {
  useChanges,
  useListRegistration,
  useWorkbench,
} from "@twigo/workbench";
import { pfUri } from "../uri";
import { FORWARDS_VIEW } from "./actions";
import { forwardKeys, withForward } from "./keys";
import type { Forwards } from "./service";
import { portWords, stateOf } from "./words";

const COLUMNS: readonly GridColumn[] = [
  { id: "state", title: "State", width: 120 },
  { id: "target", title: "Target", width: 150, grow: true },
  { id: "ports", title: "Ports", width: 130 },
  { id: "pod", title: "Pod", width: 170 },
];

interface Saved {
  readonly sort: GridSort | null;
  readonly widths: Readonly<Record<string, number>>;
}

function readSaved(saved: unknown): Saved {
  const none: Saved = { sort: null, widths: {} };
  if (typeof saved !== "object" || saved === null) return none;
  const sort =
    "sort" in saved &&
    typeof saved.sort === "object" &&
    saved.sort !== null &&
    "column" in saved.sort &&
    typeof saved.sort.column === "string" &&
    "descending" in saved.sort &&
    typeof saved.sort.descending === "boolean" &&
    COLUMNS.some(({ id }) => id === (saved.sort as GridSort).column)
      ? (saved.sort as GridSort)
      : null;
  const widths: Record<string, number> = {};
  if ("widths" in saved && typeof saved.widths === "object" && saved.widths) {
    for (const [column, width] of Object.entries(saved.widths)) {
      if (typeof width === "number") widths[column] = width;
    }
  }
  return { sort, widths };
}

/** What a column sorts a forward by. */
function keyOf(forward: Forward, column: string): string | number {
  switch (column) {
    case "state":
      return stateOf(forward).label;
    case "target":
      return forward.target.name;
    case "ports":
      return forward.port;
    default:
      return forward.pod ?? "";
  }
}

function sorted(
  forwards: readonly Forward[],
  sort: GridSort | null,
): readonly Forward[] {
  if (!sort) return forwards;
  const order = [...forwards].sort((a, b) => {
    const left = keyOf(a, sort.column);
    const right = keyOf(b, sort.column);
    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }
    return String(left).localeCompare(String(right), "en", { numeric: true });
  });
  return sort.descending ? order.reverse() : order;
}

/**
 * The space's port-forwards (ARCHITECTURE 4.1, 4.6) in a grid driven by the
 * list service: Enter opens a forward's tab, and its menu and keys act on
 * the selected row.
 */
export function ForwardsView({ forwards }: { forwards: Forwards }) {
  const { spaces } = useWorkbench();
  useChanges(spaces.changes);
  const space = spaces.active;
  if (!space) return null;
  return <SpaceForwards key={space.id} forwards={forwards} space={space.id} />;
}

function SpaceForwards({
  forwards,
  space,
}: {
  forwards: Forwards;
  space: string;
}) {
  const workbench = useWorkbench();
  const { editors, keys, menus, spaces } = workbench;
  useChanges(forwards.changes);
  useChanges(menus.changes);
  useChanges(keys.changes);
  const { sort, widths } = readSaved(spaces.view(space, FORWARDS_VIEW));
  const rows = sorted(forwards.ofSpace(space), sort);
  const selectedId = forwards.selected(space);
  const selected =
    selectedId === undefined ? undefined : forwards.get(selectedId);
  const keysOfRow = JSON.stringify(selected ? forwardKeys(selected) : {});
  const register = useListRegistration({
    forwardsFocus: true,
    ...(JSON.parse(keysOfRow) as Record<string, boolean>),
  });

  const item = (index: number): GridItem<Forward, never> | undefined => {
    const forward = rows[index];
    if (!forward) return undefined;
    const { tone } = stateOf(forward);
    return {
      type: "row",
      id: String(forward.id),
      data: forward,
      ...((tone === "error" || tone === "warn") && { tone }),
    };
  };
  const onRange = useCallback(() => undefined, []);
  const lookup = selected && withForward(keys.lookup(null), selected);

  return (
    <DataGrid<Forward, never>
      label="Port forwards"
      columns={COLUMNS}
      widths={widths}
      onResize={(column, width) => {
        spaces.setView(space, FORWARDS_VIEW, {
          sort,
          widths: { ...widths, [column]: width },
        });
      }}
      sort={sort}
      onSort={(next) => {
        spaces.setView(space, FORWARDS_VIEW, { sort: next, widths });
      }}
      length={rows.length}
      query={JSON.stringify([space, sort])}
      item={item}
      indexOf={(id) => rows.findIndex((forward) => String(forward.id) === id)}
      onRange={onRange}
      cell={(forward, column) => <Cell forward={forward} column={column.id} />}
      selected={selectedId === undefined ? undefined : String(selectedId)}
      onSelect={(_, forward) => {
        forwards.select(space, forward.id);
      }}
      onActivate={(_, forward) => {
        editors.open(pfUri({ space, id: forward.id }), {
          preview: true,
          preserveFocus: true,
        });
      }}
      menu={
        selected && lookup
          ? workbench.actions("view/item", lookup, { id: selected.id })
          : []
      }
      loading={!forwards.loaded}
      empty={
        <EmptyState
          icon={ArrowLeftRight}
          title="No port forwards"
          className="py-16"
        >
          <p>
            Select a pod, a Service or a workload and press f to forward a port
            of it to this machine.
          </p>
        </EmptyState>
      }
      register={register}
    />
  );
}

function Cell({ forward, column }: { forward: Forward; column: string }) {
  switch (column) {
    case "state": {
      const { label, tone, pulse } = stateOf(forward);
      return (
        <StatusLabel tone={tone} {...(pulse && { pulse })}>
          {label}
        </StatusLabel>
      );
    }
    case "target":
      return (
        <>
          <span className="text-muted-foreground">{forward.kind}</span>{" "}
          {forward.target.name}
        </>
      );
    case "ports":
      return `${portWords(forward)} → ${String(forward.local)}`;
    default:
      return forward.pod ?? <span className="text-muted-foreground-2">–</span>;
  }
}
