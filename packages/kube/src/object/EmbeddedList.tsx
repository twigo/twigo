import { useCallback, useState } from "react";
import type {
  EmbeddedList as Spec,
  ListQuery,
  ObjectRef,
  Row,
} from "@twigo/protocol";
import {
  Count,
  DataGrid,
  EmptyState,
  Frame,
  ROW_HEIGHT,
  TonedText,
  type GridColumn,
  type GridItem,
} from "@twigo/ui";
import {
  useChanges,
  useListRegistration,
  useWorkbench,
} from "@twigo/workbench";
import { cellTone, columnRule, statusColumn, type CellKind } from "../columns";
import { kindIcon } from "../kinds";
import { CellView, type ShownColumn } from "../list/cells";
import { SHOWS_ROWS } from "../list/listStatus";
import { useListView } from "../list/useListView";
import { objectOf } from "../selection";
import { useNow } from "../useNow";
import { useWidth } from "../useWidth";
import { ViewStatus } from "../ViewStatus";
import type { OverviewStates } from "./overviewStates";

/**
 * Inside a row's details, the list editor's selection and marks are not
 * this list's, so its resource keys find no row here; and Space and `/`
 * stay with it rather than hide the details or filter the editor.
 */
const EMBEDDED_KEYS = { "resource.selected": false, listMarked: false };

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
  const { backend } = useWorkbench();
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
      <Frame style={{ height: HEADER + rows * ROW_HEIGHT + 2 }}>
        <DataGrid<Row, never>
          label={gvr.resource}
          columns={gridColumns}
          widths={widths}
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
