import { useCallback, useEffect, useMemo, useState } from "react";
import { Columns3 } from "lucide-react";
import {
  type ListQuery,
  type Resource,
  type Row,
  type RowGroup,
  type Sort,
} from "@twigo/protocol";
import {
  ActionDropdown,
  Count,
  DataGrid,
  EmptyState,
  StatusDot,
  type GridColumn,
  type GridItem,
} from "@twigo/ui";
import {
  useChanges,
  useListRegistration,
  useWorkbench,
} from "@twigo/workbench";
import {
  byHealth,
  cellTone,
  columnRule,
  type CellKind,
  HEALTH,
  healthValues,
  statusColumn,
} from "../columns";
import { kindIcon } from "../kinds";
import type { ListServices } from "../services";
import type { ListInput } from "../uri";
import { useVisible } from "../useVisible";
import { ViewStatus } from "../ViewStatus";
import { CellView, type ShownColumn } from "./cells";
import { SHOWS_ROWS } from "./listStatus";
import { metricsNote, readsMetrics, sameBesidesMetrics } from "./metrics";
import { sequence } from "./sequence";
import { useListView } from "./useListView";

const GROUP = "group:";

/** The cells a list beside the details keeps. */
const NARROW: ReadonlySet<CellKind> = new Set(["name", "status", "ratio"]);

/**
 * A list editor's rows (ARCHITECTURE 4.4): the editor's state and its
 * kind's preset make the query, Rust sorts, filters, groups and windows,
 * and the grid draws the window with each column's rule.
 */
export function ResourceGrid(props: {
  uri: string;
  input: ListInput;
  resource: Resource;
  /** Plural, as the explorer names the kind: "Pods". */
  title: string;
  services: ListServices;
  /** Beside the details: only the columns that say what a row is and how it is. */
  narrow: boolean;
  onActivate: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  return (
    <Grid
      key={attempt}
      {...props}
      onRetry={() => {
        setAttempt((n) => n + 1);
      }}
    />
  );
}

function Grid({
  uri,
  input,
  resource,
  title,
  services,
  narrow,
  onActivate,
  onRetry,
}: {
  uri: string;
  input: ListInput;
  resource: Resource;
  title: string;
  services: ListServices;
  narrow: boolean;
  onActivate: () => void;
  onRetry: () => void;
}) {
  const workbench = useWorkbench();
  const { backend, spaces, menus, keys } = workbench;
  const { presets, states, selection, statuses, grids, measures } = services;
  useChanges(spaces.changes);
  useChanges(presets.changes);
  useChanges(states.changes);
  useChanges(selection.changes);
  useChanges(menus.changes);
  useChanges(keys.changes);
  useChanges(measures.changes);
  const { gvr } = input;
  const preset = presets.get(gvr);
  const countBy = statusColumn(gvr);
  const text = states.text(uri) ?? input.text ?? "";
  const health = states.health(uri);
  const picked = health === null ? undefined : (health?.health ?? input.health);
  const collapsed = states.collapsed(uri);
  const known = measures.get(gvr);
  const choices = Object.fromEntries(
    Object.entries(preset.columns).filter(([name]) => !known.has(name)),
  );
  const query: ListQuery = {
    space: input.space,
    gvr,
    namespaced: resource.namespaced,
    namespaces: [...(input.namespaces ?? spaces.state(input.space).namespaces)],
    labelSelector: input.labels ?? null,
    fieldSelector: null,
    owners: null,
    text: text === "" ? null : text,
    // Without a text the choices change no rows, so they stay out of the
    // query and a column toggle does not resubscribe, and the filter never
    // reads a column of a measure's kind, so once a list of the kind has
    // said which those are, their choices stay out too.
    columns: text !== "" && Object.keys(choices).length > 0 ? choices : null,
    sort: states.sort(uri) ?? null,
    countBy: countBy ?? null,
    groupBy: preset.group
      ? { column: preset.group, collapsed: [...collapsed].sort() }
      : null,
    values:
      countBy && health?.values
        ? { column: countBy, values: [...health.values] }
        : null,
  };
  const {
    snapshot,
    flash,
    query: shown,
    setWindow,
    setMetrics,
  } = useListView(backend, query);
  useEffect(() => {
    measures.learn(gvr, snapshot.columns);
  }, [measures, gvr, snapshot.columns]);
  const visible = useVisible();
  // The rows on screen as one string: churn refreshes a picked health's
  // values without reordering anything, so they stand as their healths.
  const showing = JSON.stringify(
    shown && {
      ...shown,
      values:
        shown.values &&
        Object.values(
          byHealth(
            gvr,
            shown.values.column,
            shown.values.values.map((value) => ({ value, count: 1 })),
          ),
        )
          .filter((health) => health.count > 0)
          .map((health) => health.health),
    },
  );
  const [grid, setGrid] = useState<HTMLElement | null>(null);
  // Rust groups nothing by a column the list lacks, such as Namespace in
  // a list of one namespace, and then sends no groups.
  const grouping =
    shown?.groupBy && snapshot.groups.length > 0 ? shown.groupBy : undefined;

  const every = snapshot.columns.map((column, index) => ({
    name: column.name,
    index,
    rule: columnRule(gvr, column),
    priority: column.priority,
  }));
  const columns: readonly ShownColumn[] = every.filter(
    (column) =>
      column.name === "Name" ||
      (column.name !== grouping?.column &&
        (preset.columns[column.name] ?? column.priority === 0) &&
        (!narrow || NARROW.has(column.rule.cell))),
  );
  const byName = new Map(columns.map((column) => [column.name, column]));
  const gridColumns: readonly GridColumn[] = columns.map((column) => {
    const note = metricsNote(snapshot.metrics, column);
    return {
      id: column.name,
      title: column.name,
      width: column.rule.width,
      grow: column.rule.grow,
      align: column.rule.align,
      descendFirst: column.rule.descendFirst,
      ...(note !== undefined && { note }),
    };
  });
  const reads = readsMetrics({
    columns: every,
    shown: columns,
    sort: query.sort,
    visible,
    narrow,
  });
  useEffect(() => {
    setMetrics(reads);
  }, [setMetrics, reads]);

  const items = useMemo(
    () =>
      sequence(
        grouping ? snapshot.groups : undefined,
        new Set(grouping?.collapsed),
        snapshot.total,
      ),
    [grouping, snapshot.groups, snapshot.total],
  );
  const statusIndex = countBy
    ? snapshot.columns.findIndex((column) => column.name === countBy)
    : -1;
  const item = (index: number): GridItem<Row, RowGroup> | undefined => {
    const slot = items.at(index);
    if (!slot) return undefined;
    if (slot.type === "group")
      return {
        type: "group",
        id: `${GROUP}${slot.group.value}`,
        data: slot.group,
        open: slot.open,
      };
    const id = snapshot.ids[slot.row - snapshot.start];
    const row = id === undefined ? undefined : snapshot.rows.get(id);
    if (!row) return undefined;
    const status = statusIndex < 0 ? undefined : row.cells[statusIndex];
    const tone =
      countBy && typeof status === "string"
        ? cellTone(gvr, countBy, status)
        : undefined;
    return {
      type: "row",
      id: row.id,
      data: row,
      ...((tone === "error" || tone === "warn") && { tone }),
    };
  };
  const indexOf = (id: string) => {
    if (id.startsWith(GROUP)) return items.headerOf(id.slice(GROUP.length));
    const at = snapshot.ids.indexOf(id);
    return at < 0 ? -1 : items.itemOf(snapshot.start + at);
  };
  const onRange = useCallback(
    (start: number, end: number) => {
      const [from, to] = items.rows(start, end);
      const screen = Math.max(to - from, 40);
      setWindow(Math.max(0, from - screen), to + screen);
    },
    [items, setWindow],
  );

  useEffect(() => {
    statuses.set(uri, {
      title,
      total: snapshot.total,
      status: snapshot.status,
      columns: snapshot.columns,
      counts: snapshot.counts,
    });
    // A picked health stands for the status values it had when the counts
    // last came, so new values of that health join it.
    if (countBy && picked && SHOWS_ROWS.has(snapshot.status.state)) {
      const counts = byHealth(gvr, countBy, snapshot.counts);
      states.setHealth(uri, {
        health: picked,
        values: healthValues(counts[picked]),
      });
    }
  }, [statuses, states, uri, title, gvr, countBy, snapshot, picked]);
  useEffect(
    () => () => {
      statuses.set(uri, undefined);
    },
    [statuses, uri],
  );

  const select = useCallback(
    (row: Row) => {
      selection.set(uri, {
        gvr,
        kind: resource.kind,
        namespaced: resource.namespaced,
        columns: snapshot.columns,
        row,
      });
    },
    [selection, uri, gvr, resource.kind, resource.namespaced, snapshot.columns],
  );
  const filter = JSON.stringify([
    text,
    picked ?? null,
    resource.namespaced ? [...query.namespaces].sort() : [],
  ]);
  useEffect(() => {
    selection.filter(uri, filter);
  }, [selection, uri, filter]);

  const current = selection.get(uri);
  const live = current && snapshot.rows.get(current.row.id);
  const changed =
    live !== undefined &&
    (!sameBesidesMetrics(live, current?.row, every) ||
      snapshot.columns !== current?.columns);
  useEffect(() => {
    if (changed) select(live);
  }, [changed, live, select]);
  useEffect(() => {
    if (live && !changed) selection.measure(uri, live);
  }, [selection, uri, live, changed]);

  const register = useListRegistration({
    "resource.group": resource.gvr.group,
    "resource.kind": resource.kind,
    "resource.namespaced": resource.namespaced,
  });
  const registerGrid = useCallback(
    (element: HTMLElement, controller: Parameters<typeof register>[1]) => {
      setGrid(element);
      const unregister = register(element, controller);
      const forget = grids.add(uri, element);
      return () => {
        forget();
        unregister();
        setGrid(null);
      };
    },
    [register, grids, uri],
  );
  const lookup = keys.lookup(grid);
  // The grid selects a row before it runs one of the row's inline actions,
  // so they show and run as for a selected row.
  const rowLookup = (key: string) =>
    key === "resource.selected" ? true : lookup(key);

  if (isProblem(snapshot.status.state))
    return (
      <ViewStatus
        status={snapshot.status}
        what={title.toLowerCase()}
        onRetry={onRetry}
      />
    );

  const Icon = kindIcon(gvr);
  const filtered = text !== "" || picked !== undefined;
  return (
    <DataGrid<Row, RowGroup>
      label={title}
      columns={gridColumns}
      widths={preset.widths}
      onResize={(column, width) => {
        presets.resize(gvr, column, width);
      }}
      sort={shown?.sort ?? null}
      onSort={(sort: Sort) => {
        states.setSort(uri, sort);
      }}
      length={items.length}
      query={showing}
      item={item}
      indexOf={indexOf}
      onRange={onRange}
      cell={(row, column) => {
        const shownColumn = byName.get(column.id);
        return shownColumn && <CellView row={row} column={shownColumn} />;
      }}
      group={(group) => (
        <GroupHeader
          group={group}
          gvrTitle={title}
          countBy={countBy}
          input={input}
        />
      )}
      onToggleGroup={(id) => {
        states.toggleGroup(uri, id.slice(GROUP.length));
      }}
      selected={current?.row.id}
      onSelect={(_, row) => {
        select(row);
      }}
      onActivate={onActivate}
      marked={selection.marks(uri)}
      onMark={(ids, marked) => {
        selection.mark(uri, ids, marked);
      }}
      menu={workbench.actions("resource/context", lookup)}
      inline={workbench.actions("resource/inline", rowLookup).flat()}
      headerEnd={
        <ActionDropdown
          label="Choose columns"
          title="Columns"
          keepOpen
          actions={[
            snapshot.columns
              .filter((column) => column.name !== "Name")
              .map((column) => ({
                id: column.name,
                label: column.name,
                checked: preset.columns[column.name] ?? column.priority === 0,
                run: () => {
                  presets.showColumn(
                    gvr,
                    column.name,
                    !(preset.columns[column.name] ?? column.priority === 0),
                  );
                },
              })),
          ]}
        >
          <button
            type="button"
            className="flex size-6 items-center justify-center rounded-md outline-none hover:bg-row-hover hover:text-foreground focus-visible:shadow-[var(--focus-ring)] data-[state=open]:bg-row-hover"
          >
            <Columns3 aria-hidden className="size-3.5" />
          </button>
        </ActionDropdown>
      }
      loading={!SHOWS_ROWS.has(snapshot.status.state)}
      empty={
        filtered ? (
          <EmptyState
            icon={Icon}
            title={`No matching ${title.toLowerCase()}`}
            action={{
              label: "Clear filters",
              onClick: () => {
                states.setText(uri, "");
                states.setHealth(uri, null);
              },
            }}
            className="py-16"
          >
            <p>No {title.toLowerCase()} match the filters.</p>
          </EmptyState>
        ) : (
          <EmptyState
            icon={Icon}
            title={`No ${title.toLowerCase()}`}
            className="py-16"
          >
            <p>Nothing of this kind exists in the space.</p>
          </EmptyState>
        )
      }
      flash={(id, column) => {
        const index = byName.get(column)?.index;
        return index === undefined ? undefined : flash?.since(id, index);
      }}
      register={registerGrid}
    />
  );
}

function isProblem(state: string): boolean {
  return state === "forbidden" || state === "unauthorized" || state === "error";
}

/** A group's value, its rows, and how many fail or wait (ARCHITECTURE 4.4). */
function GroupHeader({
  group,
  gvrTitle,
  countBy,
  input,
}: {
  group: RowGroup;
  gvrTitle: string;
  countBy: string | undefined;
  input: ListInput;
}) {
  const counts = countBy
    ? byHealth(input.gvr, countBy, group.counts)
    : undefined;
  return (
    <>
      <span className="truncate font-semibold text-foreground">
        {group.value === "" ? "None" : group.value}
      </span>
      <span className="text-muted-foreground">
        <Count value={group.rows} /> {gvrTitle.toLowerCase()}
      </span>
      {counts &&
        (["error", "warn"] as const)
          .filter((health) => counts[health].count > 0)
          .map((health) => (
            <span key={health} className="inline-flex items-center gap-1.5">
              <StatusDot tone={health} />
              <Count value={counts[health].count} tone={health} />{" "}
              {HEALTH[health].name}
            </span>
          ))}
    </>
  );
}
