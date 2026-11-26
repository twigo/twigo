import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import { Columns3 } from "lucide-react";
import {
  isHelmList,
  REFUSED,
  SHOWS_ROWS,
  type ListQuery,
  type Resource,
  type Row,
  type RowGroup,
  type Sort,
} from "@twigo/protocol";
import {
  ActionDropdown,
  COLUMN_MIN_WIDTH,
  Count,
  DataGrid,
  EmptyState,
  GUTTERS_WIDTH,
  StatusDot,
  useWidth,
  type GridColumn,
  type GridItem,
} from "@twigo/ui";
import {
  useChanges,
  useListRegistration,
  useWorkbench,
  type Lookup,
} from "@twigo/workbench";
import { CAPABILITY_PREFIXES } from "../capabilities";
import {
  byHealth,
  columnRule,
  HEALTH,
  healthValues,
  problemColumn,
  problemOf,
  rowFinished,
  rowTone,
  statusColumn,
} from "../columns";
import { inText, kindIcon } from "../kinds";
import { rowState } from "../rowState";
import { cellsOf, objectOfRow } from "../selection";
import type { ListServices } from "../services";
import type { ListInput } from "../uri";
import { useVisible } from "../useVisible";
import { useReopen } from "../useReopen";
import { ViewStatus } from "../ViewStatus";
import { leavesOut, waitingLine } from "./listStatus";
import { decideRows } from "./alarm";
import { CellView } from "./cells";
import { fitGrid } from "./fit";
import { readsMetrics, sameBesidesMetrics } from "./metrics";
import { mayListWords, namespacesOf, whereWords } from "./scope";
import { sequence } from "./sequence";
import { useListView } from "./useListView";

const GROUP = "group:";

/**
 * A list editor's rows (ARCHITECTURE 4.4): the editor's state and its
 * kind's preset make the query, Rust sorts, filters, groups and windows,
 * and the grid draws the window with each column's rule.
 */
export function ResourceGrid(
  props: Omit<ComponentProps<typeof Grid>, "onRetry">,
) {
  const [key, reopen] = useReopen();
  return <Grid key={key} {...props} onRetry={reopen} />;
}

function Grid({
  uri,
  input,
  resource,
  title,
  services,
  details,
  onActivate,
  onRetry,
}: {
  uri: string;
  input: ListInput;
  resource: Resource;
  /** Plural, as the explorer names the kind: "Pods". */
  title: string;
  services: ListServices;
  /**
   * Where the selected row's details show: beside the list, with that row's
   * actions, or over the list's right side, rows' ends included.
   */
  details: "beside" | "over" | undefined;
  onActivate: () => void;
  onRetry: () => void;
}) {
  const workbench = useWorkbench();
  const {
    backend,
    spaces,
    menus,
    keys,
    commands,
    catalog,
    editors,
    quickAccess,
  } = workbench;
  const {
    presets,
    states,
    selection,
    statuses,
    grids,
    measures,
    capabilities,
  } = services;
  useChanges(spaces.changes);
  useChanges(states.changes);
  useChanges(selection.changes);
  useChanges(menus.changes);
  useChanges(keys.changes);
  useChanges(measures.changes);
  useChanges(capabilities.changes);
  const { gvr } = input;
  const preset = useSyncExternalStore(presets.changes.subscribe, () =>
    presets.get(gvr),
  );
  const countBy = useMemo(() => statusColumn(gvr), [gvr]);
  const text = states.text(uri) ?? input.text ?? "";
  const health = states.health(uri);
  const picked = health === null ? undefined : (health?.health ?? input.health);
  const collapsed = states.collapsed(uri);
  const known = measures.get(input.space, gvr);
  const choices = Object.fromEntries(
    Object.entries(preset.columns).filter(([name]) => !known.has(name)),
  );
  const query: ListQuery = {
    space: input.space,
    gvr,
    namespaced: resource.namespaced,
    namespaces: [...namespacesOf(spaces, input)],
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
    measures.learn(input.space, gvr, snapshot.columns);
  }, [measures, input.space, gvr, snapshot.columns]);
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
  const width = useWidth(grid);
  // Rust groups nothing by a column the list lacks, such as Namespace in
  // a list of one namespace, and then sends no groups.
  const grouping =
    shown?.groupBy && snapshot.groups.length > 0 ? shown.groupBy : undefined;

  const every = useMemo(
    () =>
      snapshot.columns.map((column, index) => ({
        name: column.name,
        index,
        rule: columnRule(gvr, column),
        priority: column.priority,
      })),
    [gvr, snapshot.columns],
  );
  const grouped = grouping?.column;
  const { columns: chosenByName, widths: savedWidths } = preset;
  const chosen = useMemo(
    () =>
      every.filter(
        (column) =>
          column.name === "Name" ||
          (column.name !== grouped &&
            !column.rule.problem &&
            (chosenByName[column.name] ?? column.priority === 0)),
      ),
    [every, grouped, chosenByName],
  );
  const sorted = shown?.sort;
  const fitted = useMemo(
    () =>
      fitGrid({
        chosen,
        widths: savedWidths,
        room: width > 0 ? width - GUTTERS_WIDTH : Infinity,
        metrics: snapshot.metrics,
        sort: sorted,
      }),
    [chosen, savedWidths, width, snapshot.metrics, sorted],
  );
  const { columns, byName, mergedRoom, widened } = fitted;
  const gridColumns = useMemo(
    () =>
      fitted.gridColumns.map((column) => ({
        ...column,
        coverable: byName.get(column.id)?.rule.coverable,
      })),
    [fitted, byName],
  );
  // While a new subscription has no columns yet, what was drawn stays drawn.
  const [drawnBefore, setDrawnBefore] = useState<readonly string[]>();
  const drawnNow = every.length > 0 ? [...byName.keys()] : undefined;
  if (drawnNow && drawnNow.join("\n") !== drawnBefore?.join("\n"))
    setDrawnBefore(drawnNow);
  const reads = readsMetrics({
    measures:
      every.length > 0
        ? every.filter((column) => column.rule.metric).map(({ name }) => name)
        : measures.knows(input.space, gvr)
          ? [...known]
          : undefined,
    drawn: (name) =>
      every.length > 0
        ? byName.has(name)
        : drawnBefore
          ? drawnBefore.includes(name)
          : preset.columns[name] !== false,
    sort: query.sort,
    visible,
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
  const decide = useMemo(
    () =>
      decideRows(
        (row) => rowTone(gvr, countBy, snapshot.columns, row),
        (row) => rowFinished(gvr, countBy, snapshot.columns, row),
        columns,
      ),
    [gvr, countBy, snapshot.columns, columns],
  );
  const problemAt = useMemo(
    () => problemColumn(gvr, snapshot.columns),
    [gvr, snapshot.columns],
  );
  const cell = useCallback(
    (row: Row, column: GridColumn) => {
      const shownColumn = byName.get(column.id);
      if (!shownColumn) return undefined;
      const { tone, alarmed, finished } = decide(row);
      return (
        <CellView
          row={row}
          column={shownColumn}
          tone={tone}
          alarmed={alarmed}
          finished={finished}
          problem={
            shownColumn.rule.health ? problemOf(problemAt, row) : undefined
          }
        />
      );
    },
    [byName, decide, problemAt],
  );
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
    const { tone } = decide(row);
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
      parts: snapshot.parts,
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
    [register, grids, uri, setGrid],
  );
  const problem = REFUSED.has(snapshot.status.state);
  // The problem takes the grid's place, and with it the focus it held, which
  // falls to the page.
  useLayoutEffect(() => {
    if (problem) editors.keepFocus("editor");
  }, [problem, editors]);
  const lookup = keys.lookup(grid);
  const referenced = CAPABILITY_PREFIXES.flatMap((prefix) =>
    commands.referenced(prefix),
  );
  // The grid selects a row before it runs one of its icons, so they show
  // and run as for a selected row, with that row's own state and what RBAC
  // answers for it once the pointer rests on it.
  const rowLookup = (row: Row): Lookup => {
    if (row.id === current?.row.id)
      return (key) => (key === "resource.selected" ? true : lookup(key));
    const own: Record<string, boolean> = {
      ...rowState(
        resource,
        cellsOf({
          gvr,
          kind: resource.kind,
          namespaced: resource.namespaced,
          columns: snapshot.columns,
          row,
        }),
      ),
      ...capabilities.hovered(
        uri,
        objectOfRow(row.id, resource.namespaced),
        referenced,
      ),
    };
    return (key) => {
      if (key === "resource.selected") return true;
      if (key in own) return own[key];
      return lookup(key);
    };
  };

  if (problem)
    return (
      <ViewStatus
        status={snapshot.status}
        what={inText(title)}
        onRetry={onRetry}
        {...(resource.namespaced &&
          query.namespaces.length === 0 && {
            onChoose: () => {
              quickAccess.show("ns ");
            },
          })}
        {...(isHelmList(gvr) && {
          releases: {
            where:
              query.namespaces.length === 0
                ? "this cluster"
                : query.namespaces.join(", "),
          },
        })}
      />
    );

  const Icon = kindIcon(gvr);
  const things = inText(title);
  const filtered = text !== "" || picked !== undefined;
  const scope = resource.namespaced ? query.namespaces : [];
  const narrowed = scope.length > 0;
  const where = leavesOut(snapshot.parts)
    ? "the namespaces shown"
    : (mayListWords(snapshot.parts) ?? whereWords(spaces, input.space, scope));
  return (
    <DataGrid<Row, RowGroup>
      label={title}
      columns={gridColumns}
      widths={{ ...preset.widths, ...widened }}
      onResize={(column, width) => {
        presets.resize(
          gvr,
          column,
          Math.max(COLUMN_MIN_WIDTH, width - mergedRoom(column)),
        );
      }}
      sort={sorted ?? null}
      onSort={(sort: Sort) => {
        states.setSort(uri, sort);
      }}
      length={items.length}
      query={showing}
      item={item}
      indexOf={indexOf}
      onRange={onRange}
      cell={cell}
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
      onOpen={(_, row) => {
        select(row);
        void commands.execute(
          isHelmList(gvr) ? "helm.release.open" : "k8s.resource.openEditor",
          lookup,
        );
      }}
      marked={selection.marks(uri)}
      onMark={(ids, marked) => {
        selection.mark(uri, ids, marked);
      }}
      menu={workbench.actions("resource/context", lookup)}
      inline={
        details === "over"
          ? undefined
          : (row) =>
              details === "beside" && row.id === current?.row.id
                ? []
                : workbench
                    .actions("resource/details", rowLookup(row))
                    .flat()
                    .filter((action) => action.pinned)
                    .slice(0, 2)
      }
      onRest={(row) =>
        row.id === current?.row.id
          ? () => undefined
          : capabilities.askHovered(
              uri,
              input.space,
              resource.gvr,
              objectOfRow(row.id, resource.namespaced),
              referenced,
              catalog.list,
            )
      }
      headerEnd={
        <ActionDropdown
          label="Choose columns"
          title="Columns"
          keepOpen
          actions={[
            snapshot.columns
              .filter(
                (column) =>
                  column.name !== "Name" && !columnRule(gvr, column).problem,
              )
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
            className="flex size-6 items-center justify-center rounded-md outline-none hover:bg-row-hover hover:text-content focus-visible:shadow-[var(--focus-ring)] data-[state=open]:bg-row-hover"
          >
            <Columns3 aria-hidden className="size-3.5" />
          </button>
        </ActionDropdown>
      }
      loading={!SHOWS_ROWS.has(snapshot.status.state)}
      waiting={waitingLine(snapshot.status)}
      empty={
        filtered ? (
          <EmptyState
            icon={Icon}
            title={`No matching ${things} in ${where}`}
            action={{
              label: "Clear filters",
              onClick: () => {
                states.setText(uri, "");
                states.setHealth(uri, null);
              },
            }}
            className="py-16"
          >
            <p>No {things} match the filters.</p>
          </EmptyState>
        ) : (
          <EmptyState
            icon={Icon}
            title={`No ${things} in ${where}`}
            className="py-16"
          >
            <p>
              {leavesOut(snapshot.parts)
                ? "The namespaces that are not ready are left out; the status bar says which."
                : snapshot.parts.omitted > 0
                  ? `Nothing of this kind exists in them, and these credentials may not list ${isHelmList(gvr) ? "Secrets" : things} in the other ${String(snapshot.parts.omitted)}.`
                  : narrowed
                    ? "Nothing of this kind exists in these namespaces."
                    : "Nothing of this kind exists in the space."}
            </p>
          </EmptyState>
        )
      }
      flash={(id) => flash?.of(id)}
      register={registerGrid}
    />
  );
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
      <span className="truncate font-semibold text-content">
        {group.value === "" ? "None" : group.value}
      </span>
      <span className="text-support">
        <Count value={group.rows} /> {inText(gvrTitle)}
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
