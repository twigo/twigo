import { useCallback, useEffect, useState } from "react";
import {
  SHOWS_ROWS,
  type EmbeddedList as Spec,
  type ListQuery,
  type ObjectRef,
  type Row,
} from "@twigo/protocol";
import {
  ACTIONS_WIDTH,
  Count,
  DataGrid,
  EmptyState,
  Frame,
  ROW_HEIGHT,
  TonedText,
  type GridItem,
  useWidth,
} from "@twigo/ui";
import {
  useChanges,
  useListRegistration,
  useWorkbench,
} from "@twigo/workbench";
import {
  cellTone,
  columnRule,
  rowFinished,
  rowTone,
  statusColumn,
} from "../columns";
import { kindIcon } from "../kinds";
import { decideRows } from "../list/alarm";
import { CellView } from "../list/cells";
import { fitGrid } from "../list/fit";
import { readsMetrics } from "../list/metrics";
import { whereWords } from "../list/scope";
import { useListView } from "../list/useListView";
import { objectOf } from "../selection";
import { useVisible } from "../useVisible";
import { ViewStatus } from "../ViewStatus";
import { isProblem } from "../viewProblem";
import type { OverviewStates } from "./overviewStates";

/**
 * Inside a row's details, the list editor's selection and marks are not
 * this list's, so its resource keys find no row here; and Space stays with
 * it rather than hide the details, and `/` opens the filter of the page it
 * is in rather than the editor's.
 */
const EMBEDDED_KEYS = { "resource.selected": false, listMarked: false };

/** Rows an embedded list shows before it scrolls. */
const VISIBLE = 8;
const HEADER = 28;
/** The frame's border on each side of the grid. */
const FRAME_BORDER = 2;

/**
 * A live list inside an Overview (ARCHITECTURE 4.3), such as a workload's
 * pods: a query view of the object's space like any list, with the
 * columns the server prints first, its rows counted by their status, and
 * a row opening its object. As its width falls its columns leave in the
 * order a list's do (4.4).
 */
export function EmbeddedList({
  list,
  space,
  states,
  kind,
  id,
  onOpen,
}: {
  list: Spec;
  space: string;
  /** Where its sort and widths are kept, for every object of `kind`. */
  states: OverviewStates;
  kind: string;
  /** Its section's, which keys its state. */
  id: string;
  onOpen: (target: ObjectRef) => void;
}) {
  const { backend, spaces } = useWorkbench();
  const register = useListRegistration(EMBEDDED_KEYS, ["peek", "filter"]);
  const { gvr } = list;
  const countBy = statusColumn(gvr);
  useChanges(states.changes);
  const sort = states.sort(kind, id);
  const widths = states.widths(kind, id);
  const [selected, setSelected] = useState<string>();
  const query: ListQuery = {
    space,
    gvr,
    namespaced: list.namespaced,
    namespaces: list.namespace === null ? [] : [list.namespace],
    labelSelector: null,
    fieldSelector: list.fieldSelector,
    owners: list.owners,
    text: null,
    columns: null,
    sort,
    countBy: countBy ?? null,
    groupBy: null,
    values: null,
  };
  const { snapshot, flash, setWindow, setMetrics } = useListView(
    backend,
    query,
  );
  const visible = useVisible();
  const [element, setElement] = useState<HTMLElement | null>(null);
  // 0 until the first measure, which comes after the first window.
  const width = useWidth(element);
  const every = snapshot.columns.map((column, index) => ({
    name: column.name,
    index,
    rule: columnRule(gvr, column),
    priority: column.priority,
  }));
  const { columns, byName, widened, gridColumns } = fitGrid({
    chosen: every.filter(
      (column) => column.name === "Name" || column.priority === 0,
    ),
    widths,
    room: width > 0 ? width - FRAME_BORDER - ACTIONS_WIDTH : Infinity,
    metrics: snapshot.metrics,
    sort,
  });
  const reads = readsMetrics({
    measures:
      every.length > 0
        ? every.filter((column) => column.rule.metric).map(({ name }) => name)
        : undefined,
    drawn: (name) => byName.has(name),
    sort,
    visible,
  });
  useEffect(() => {
    setMetrics(reads);
  }, [setMetrics, reads]);
  const decide = decideRows(
    (row) => rowTone(gvr, countBy, snapshot.columns, row),
    (row) => rowFinished(gvr, countBy, snapshot.columns, row),
    columns,
  );
  const item = (index: number): GridItem<Row, never> | undefined => {
    const id = snapshot.ids[index - snapshot.start];
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
  const onRange = useCallback(
    (start: number, end: number) => {
      const screen = Math.max(end - start, VISIBLE);
      setWindow(Math.max(0, start - screen), end + screen);
    },
    [setWindow],
  );
  const open = (row: Row) => {
    const { namespace, name } = objectOf({
      gvr,
      kind: list.kind,
      namespaced: list.namespaced,
      columns: snapshot.columns,
      row,
    });
    onOpen({
      group: gvr.group,
      version: gvr.version,
      kind: list.kind,
      namespace: namespace ?? null,
      name,
    });
  };
  if (isProblem(snapshot.status))
    return <ViewStatus status={snapshot.status} what={gvr.resource} inline />;
  const Icon = kindIcon(gvr);
  const loading = !SHOWS_ROWS.has(snapshot.status.state);
  if (!loading && snapshot.total === 0)
    return (
      <EmptyState icon={Icon} density="inline" className="px-0">
        {`No ${gvr.resource} in ${whereWords(spaces, space, query.namespaces)}`}
      </EmptyState>
    );
  const rows = Math.min(Math.max(snapshot.total, loading ? 3 : 1), VISIBLE);
  return (
    <div ref={setElement} className="flex flex-col gap-1.5">
      {snapshot.counts.length > 0 && (
        <p className="flex flex-wrap gap-x-3 text-xs text-support">
          {snapshot.counts.map((count) => {
            const tone = countBy
              ? cellTone(gvr, countBy, count.value)
              : undefined;
            return (
              <span key={count.value}>
                <Count value={count.count} />{" "}
                {tone ? (
                  <TonedText tone={tone}>{count.value}</TonedText>
                ) : (
                  count.value
                )}
              </span>
            );
          })}
        </p>
      )}
      <Frame style={{ height: HEADER + rows * ROW_HEIGHT + 2 }}>
        <DataGrid<Row, never>
          label={gvr.resource}
          columns={gridColumns}
          widths={{ ...widths, ...widened }}
          onResize={(column, width) => {
            states.resize(kind, id, column, width);
          }}
          sort={sort}
          onSort={(next) => {
            states.setSort(kind, id, next);
          }}
          length={snapshot.total}
          query={JSON.stringify(query)}
          item={item}
          indexOf={(id) => {
            const at = snapshot.ids.indexOf(id);
            return at < 0 ? -1 : snapshot.start + at;
          }}
          onRange={onRange}
          cell={(row, column) => {
            const shown = byName.get(column.id);
            if (!shown) return undefined;
            const { tone, alarmed, finished } = decide(row);
            return (
              <CellView
                row={row}
                column={shown}
                tone={tone}
                alarmed={alarmed}
                finished={finished}
              />
            );
          }}
          selected={selected}
          onSelect={(id) => {
            setSelected(id);
          }}
          onActivate={(_, row) => {
            open(row);
          }}
          loading={loading}
          register={register}
          flash={(id, column) => {
            const index = byName.get(column)?.index;
            return index === undefined ? undefined : flash?.since(id, index);
          }}
        />
      </Frame>
    </div>
  );
}
