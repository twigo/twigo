import { useCallback, useState } from "react";
import type {
  EmbeddedList as Spec,
  ListQuery,
  ObjectRef,
  Row,
  Sort,
} from "@twigo/protocol";
import {
  Count,
  DataGrid,
  EmptyState,
  ROW_HEIGHT,
  TonedText,
  type GridColumn,
  type GridItem,
} from "@twigo/ui";
import { useWorkbench } from "@twigo/workbench";
import { cellTone, columnRule, statusColumn, type CellKind } from "../columns";
import { kindIcon } from "../kinds";
import { CellView, type ShownColumn } from "../list/cells";
import { SHOWS_ROWS } from "../list/listStatus";
import { useListView } from "../list/useListView";
import { objectOf } from "../selection";
import { useNow } from "../useNow";
import { useWidth } from "../useWidth";
import { ViewStatus } from "../ViewStatus";

/** Rows an embedded list shows before it scrolls. */
const VISIBLE = 8;
const HEADER = 28;
/** Narrower than this, as in the details beside a list, it keeps fewer columns. */
const WIDE = 640;
const NARROW: ReadonlySet<CellKind> = new Set(["name", "ratio", "status"]);
/** The least a narrow list's name column takes. */
const NARROW_NAME = 160;

/**
 * A live list inside an Overview (ARCHITECTURE 4.3), such as a workload's
 * pods: a query view of the object's space like any list, with the
 * columns the server prints first, its rows counted by their status, and
 * a row opening its object.
 */
export function EmbeddedList({
  list,
  space,
  onOpen,
}: {
  list: Spec;
  space: string;
  onOpen: (target: ObjectRef) => void;
}) {
  const { backend } = useWorkbench();
  const { gvr } = list;
  const countBy = statusColumn(gvr);
  const [sort, setSort] = useState<Sort | null>(null);
  const [selected, setSelected] = useState<string>();
  const [widths, setWidths] = useState<Readonly<Record<string, number>>>({});
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
  const { snapshot, flash, setWindow } = useListView(backend, query);
  const now = useNow(1000);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const narrow = useWidth(element) < WIDE;
  const columns: readonly ShownColumn[] = snapshot.columns
    .map((column, index) => ({
      name: column.name,
      index,
      rule: columnRule(gvr, column),
      priority: column.priority,
    }))
    .filter(
      (column) =>
        column.name === "Name" ||
        (column.priority === 0 && (!narrow || NARROW.has(column.rule.cell))),
    );
  const byName = new Map(columns.map((column) => [column.name, column]));
  const gridColumns: readonly GridColumn[] = columns.map((column) => ({
    id: column.name,
    title: column.name,
    width:
      narrow && column.rule.grow
        ? Math.min(column.rule.width, NARROW_NAME)
        : column.rule.width,
    grow: column.rule.grow,
    align: column.rule.align,
  }));
  const statusAt = countBy
    ? snapshot.columns.findIndex((column) => column.name === countBy)
    : -1;
  const item = (index: number): GridItem<Row, never> | undefined => {
    const id = snapshot.ids[index - snapshot.start];
    const row = id === undefined ? undefined : snapshot.rows.get(id);
    if (!row) return undefined;
    const status = statusAt < 0 ? undefined : row.cells[statusAt];
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
  const state = snapshot.status.state;
  if (state === "forbidden" || state === "unauthorized" || state === "error")
    return <ViewStatus status={snapshot.status} what={gvr.resource} inline />;
  const Icon = kindIcon(gvr);
  const loading = !SHOWS_ROWS.has(state);
  if (!loading && snapshot.total === 0)
    return (
      <EmptyState icon={Icon} density="inline" className="px-0">
        No {gvr.resource}
      </EmptyState>
    );
  const rows = Math.min(Math.max(snapshot.total, loading ? 3 : 1), VISIBLE);
  return (
    <div ref={setElement} className="flex flex-col gap-1.5">
      {snapshot.counts.length > 0 && (
        <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
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
      <div
        className="overflow-hidden rounded-md shadow-[inset_0_0_0_1px_var(--border)]"
        style={{ height: HEADER + rows * ROW_HEIGHT + 2 }}
      >
        <DataGrid<Row, never>
          label={gvr.resource}
          columns={gridColumns}
          widths={widths}
          onResize={(column, width) => {
            setWidths({ ...widths, [column]: width });
          }}
          sort={sort}
          onSort={setSort}
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
            return shown && <CellView row={row} column={shown} now={now} />;
          }}
          selected={selected}
          onSelect={(id) => {
            setSelected(id);
          }}
          onActivate={(_, row) => {
            open(row);
          }}
          loading={loading}
          flash={(id, column) => {
            const index = byName.get(column)?.index;
            return index === undefined ? undefined : flash?.since(id, index);
          }}
        />
      </div>
    </div>
  );
}
