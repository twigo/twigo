import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  KeyRound,
  ShieldOff,
} from "lucide-react";
import type {
  Backend,
  Cell,
  Column,
  ColumnValues,
  GroupCount,
  Gvr,
  ListSnapshot,
  Row,
  RowId,
  Sort,
  ViewState,
} from "@twigo/protocol";
import { cn, EmptyState, Skeleton } from "@twigo/ui";
import { humanDuration } from "@twigo/utils";
import type { FlashTracker } from "./flash";
import { kindIcon } from "./kinds";
import { alignsEnd, cellParts, quietColumn } from "./columns";
import { cellTone, statusColumn } from "./tones";
import { useListView } from "./useListView";
import { useNow } from "./useNow";

const ROW_HEIGHT = 22;

/** States in which Rust sends rows; the loading states show skeletons. */
const SHOWS_ROWS = new Set<ViewState["state"]>(["ready", "relisting", "stale"]);

/** What keyboard commands do to the focused table. */
export interface ListController {
  move(delta: number): void;
  moveToEdge(edge: "first" | "last"): void;
  /** Opens the selected row, as a click on it does. */
  activate(): void;
}

interface Props {
  backend: Backend;
  space: string;
  gvr: Gvr;
  /** Plural, as the explorer names the kind: "Pods". */
  title: string;
  /** Empty or absent for every namespace the space covers. */
  namespaces?: readonly string[];
  text?: string;
  /** Only the rows whose column holds one of these values. */
  values?: ColumnValues;
  labelSelector?: string;
  /** The row selected when the table mounts, such as the one it had before. */
  initialSelected?: RowId;
  /** The selected row, whenever it changes or its data does. */
  onSelect?: (row: Row, columns: readonly Column[]) => void;
  /** A row the user opened: a click, or Enter through `activate`. */
  onActivate?: (row: Row) => void;
  /** How many rows match and the view's state, as they change. */
  onStatus?: (
    total: number,
    status: ViewState,
    groups: readonly GroupCount[],
  ) => void;
  /** Registers the focusable grid while it is mounted, for context keys and commands. */
  register?: (grid: HTMLElement, list: ListController) => () => void;
}

export function ResourceTable(props: Props) {
  const [attempt, setAttempt] = useState(0);
  return (
    <ResourceList
      key={attempt}
      {...props}
      onRetry={() => {
        setAttempt((n) => n + 1);
      }}
    />
  );
}

function ResourceList({
  backend,
  space,
  gvr,
  title,
  namespaces = [],
  text,
  values,
  labelSelector,
  initialSelected,
  onSelect,
  onActivate,
  onStatus,
  register,
  onRetry,
}: Props & { onRetry: () => void }) {
  const [sort, setSort] = useState<Sort | null>(null);
  const [selected, setSelected] = useState(initialSelected);
  const { snapshot, flash, setWindow } = useListView(backend, {
    space,
    gvr,
    namespaces: [...namespaces],
    labelSelector: labelSelector ?? null,
    text: text ?? null,
    sort,
    groupBy: statusColumn(gvr) ?? null,
    values: values ?? null,
  });
  const now = useNow(1000);
  const [grid, setGrid] = useState<HTMLDivElement | null>(null);
  const { status } = snapshot;
  const showsRows = SHOWS_ROWS.has(status.state);
  const columns = snapshot.columns
    .map((column, index) => ({ ...column, index }))
    .filter((column) => column.priority === 0);

  const virtualizer = useVirtualizer({
    count: showsRows ? snapshot.total : 0,
    getScrollElement: () => grid,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    initialRect: { width: 0, height: 600 },
  });
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items[items.length - 1]?.index ?? first;

  useEffect(() => {
    const screen = Math.max(last - first + 1, 40);
    setWindow(Math.max(0, first - screen), last + 1 + screen);
  }, [setWindow, first, last]);

  // A keyboard move can land outside the window; it selects once the row arrives.
  const [wanted, setWanted] = useState<number>();
  const wantedRow = wanted === undefined ? undefined : rowAt(snapshot, wanted);
  useEffect(() => {
    if (wantedRow) {
      setSelected(wantedRow.id);
      setWanted(undefined);
    }
  }, [wantedRow]);

  const latest = useRef({ snapshot, selected, onActivate });
  useEffect(() => {
    latest.current = { snapshot, selected, onActivate };
  });
  const controller = useMemo<ListController>(() => {
    const go = (index: number) => {
      const { total } = latest.current.snapshot;
      if (total === 0) return;
      const target = Math.min(Math.max(index, 0), total - 1);
      virtualizer.scrollToIndex(target);
      setWanted(target);
    };
    return {
      move(delta) {
        const { snapshot: shown, selected: id } = latest.current;
        const at = id === undefined ? -1 : indexOf(shown, id);
        go(at < 0 ? shown.start : at + delta);
      },
      moveToEdge(edge) {
        go(edge === "first" ? 0 : latest.current.snapshot.total - 1);
      },
      activate() {
        const {
          snapshot: shown,
          selected: id,
          onActivate: open,
        } = latest.current;
        const row = id === undefined ? undefined : shown.rows.get(id);
        if (row) open?.(row);
      },
    };
  }, [virtualizer]);

  useEffect(() => {
    if (!grid || !register) return;
    return register(grid, controller);
  }, [grid, register, controller]);

  const selectedRow =
    selected === undefined ? undefined : snapshot.rows.get(selected);
  useEffect(() => {
    if (selectedRow) onSelect?.(selectedRow, snapshot.columns);
  }, [onSelect, selectedRow, snapshot.columns]);

  useEffect(() => {
    onStatus?.(snapshot.total, status, snapshot.groups);
  }, [onStatus, snapshot.total, status, snapshot.groups]);

  const [widths, setWidths] = useState<Readonly<Record<string, number>>>({});
  const widthOf = (column: Column) =>
    widths[column.name] ?? defaultWidth(column);
  const Icon = kindIcon(gvr);
  // Columns share the free width in proportion to their widths, except
  // those the user sized; a filler takes it once every column is sized.
  const flexes = (column: Column) => widths[column.name] === undefined;
  const template = [
    ...columns.map((column) => {
      const px = String(widthOf(column));
      return flexes(column) ? `minmax(${px}px, ${px}fr)` : `${px}px`;
    }),
    ...(columns.some(flexes) ? [] : ["minmax(0, 1fr)"]),
  ].join(" ");
  const total = columns.reduce((sum, column) => sum + widthOf(column), 0);

  return (
    <section className="flex h-full min-h-0 flex-col bg-editor">
      {problem(status, title, onRetry) ?? (
        <div
          ref={setGrid}
          role="grid"
          tabIndex={0}
          aria-label={title}
          aria-rowcount={snapshot.total + 1}
          className="group min-h-0 flex-1 overflow-auto outline-none"
        >
          <div
            role="row"
            aria-rowindex={1}
            className="group/header sticky top-0 z-10 grid h-7 items-center border-b border-border bg-editor text-xs text-muted-foreground"
            style={{ gridTemplateColumns: template, minWidth: total }}
          >
            {columns.map((column) => (
              <HeaderCell
                key={column.name}
                column={column}
                end={alignsEnd(gvr, column)}
                width={widthOf(column)}
                sort={sort}
                onSort={setSort}
                onResize={(next) => {
                  setWidths((current) => ({ ...current, [column.name]: next }));
                }}
              />
            ))}
          </div>
          {!showsRows ? (
            <SkeletonRows template={template} count={columns.length || 5} />
          ) : snapshot.total === 0 ? (
            <EmptyState
              icon={Icon}
              title={`No ${title.toLowerCase()}`}
              className="py-16"
            >
              <p>Nothing of this kind exists in the space.</p>
            </EmptyState>
          ) : (
            <div
              className="relative"
              style={{ height: virtualizer.getTotalSize(), minWidth: total }}
            >
              {items.map((item) => {
                const row = rowAt(snapshot, item.index);
                return (
                  <div
                    key={row?.id ?? `pending-${String(item.index)}`}
                    role="row"
                    aria-rowindex={item.index + 2}
                    aria-selected={row !== undefined && row.id === selected}
                    onClick={() => {
                      setSelected(row?.id);
                      if (row) onActivate?.(row);
                    }}
                    className={cn(
                      "absolute inset-x-0 grid items-center border-b border-border-micro tabular-nums hover:bg-row-hover",
                      row !== undefined &&
                        row.id === selected &&
                        "bg-selected-unfocused group-focus:bg-selected",
                    )}
                    style={{
                      top: item.start,
                      height: ROW_HEIGHT,
                      gridTemplateColumns: template,
                    }}
                  >
                    {columns.map((column) =>
                      row ? (
                        <DataCell
                          key={column.name}
                          row={row}
                          column={column}
                          gvr={gvr}
                          now={now}
                          flash={flash}
                        />
                      ) : (
                        <div key={column.name} className="px-2">
                          <Skeleton className="h-2.5 w-3/5" />
                        </div>
                      ),
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function indexOf(snapshot: ListSnapshot, id: RowId): number {
  const at = snapshot.ids.indexOf(id);
  return at < 0 ? -1 : snapshot.start + at;
}

function rowAt(snapshot: ListSnapshot, index: number): Row | undefined {
  const id = snapshot.ids[index - snapshot.start];
  return id === undefined ? undefined : snapshot.rows.get(id);
}

type IndexedColumn = Column & { index: number };

/** Starting widths in px; the user drags a header's edge to change one. */
const WIDTHS: Readonly<Record<string, number>> = {
  Name: 280,
  Namespace: 140,
  Context: 120,
  Ready: 64,
  Status: 170,
  Restarts: 120,
};

const MIN_WIDTH = 48;

function defaultWidth(column: Column): number {
  if (column.kind === "age") return 72;
  return WIDTHS[column.name] ?? 140;
}

function HeaderCell({
  column,
  end,
  width,
  sort,
  onSort,
  onResize,
}: {
  column: IndexedColumn;
  end: boolean;
  width: number;
  sort: Sort | null;
  onSort: (sort: Sort) => void;
  onResize: (width: number) => void;
}) {
  const active = sort?.column === column.name;
  const Arrow = active && sort.descending ? ArrowDown : ArrowUp;
  return (
    <div className="relative h-full border-r border-transparent group-hover/header:border-border-subtle">
      <SortButton
        column={column}
        end={end}
        active={active}
        sort={sort}
        onSort={onSort}
        Arrow={Arrow}
      />
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${column.name}`}
        onPointerDown={(event) => {
          event.preventDefault();
          const start = event.clientX;
          const target = event.currentTarget;
          // A flexing column is wider than its width on screen.
          const from = Math.max(
            width,
            target.parentElement?.getBoundingClientRect().width ?? 0,
          );
          target.setPointerCapture(event.pointerId);
          const move = (next: PointerEvent) => {
            onResize(Math.max(MIN_WIDTH, from + next.clientX - start));
          };
          target.addEventListener("pointermove", move);
          target.addEventListener(
            "pointerup",
            () => {
              target.removeEventListener("pointermove", move);
            },
            { once: true },
          );
        }}
        className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize hover:bg-brand/40"
      />
    </div>
  );
}

function SortButton({
  column,
  end,
  active,
  sort,
  onSort,
  Arrow,
}: {
  column: IndexedColumn;
  end: boolean;
  active: boolean;
  sort: Sort | null;
  onSort: (sort: Sort) => void;
  Arrow: typeof ArrowUp;
}) {
  return (
    <button
      type="button"
      role="columnheader"
      aria-sort={
        active ? (sort?.descending ? "descending" : "ascending") : "none"
      }
      onClick={() => {
        onSort({
          column: column.name,
          descending: active && sort?.descending !== true,
        });
      }}
      className={cn(
        "flex h-full w-full items-center gap-1 px-2 text-left hover:text-foreground",
        end && "flex-row-reverse text-right",
        active && "text-foreground",
      )}
    >
      <span className="truncate">{column.name}</span>
      {active && <Arrow className="size-3 shrink-0" />}
    </button>
  );
}

function DataCell({
  row,
  column,
  gvr,
  now,
  flash,
}: {
  row: Row;
  column: IndexedColumn;
  gvr: Gvr;
  now: number;
  flash: FlashTracker | undefined;
}) {
  const text = cellText(row.cells[column.index] ?? null, column, row, now);
  const tone = cellTone(gvr, column.name, text);
  const status = column.name === statusColumn(gvr);
  const parts = cellParts(gvr, column.name, text);
  const since = flash?.since(row.id, column.index);
  return (
    <div
      role="gridcell"
      className={cn(
        "truncate px-2",
        alignsEnd(gvr, column) && "text-right",
        (quietColumn(column) || parts.quiet) && "text-muted-foreground",
        text === "<none>" && "text-muted-foreground-2",
      )}
    >
      <span
        key={since ?? "steady"}
        className={cn(
          "-mx-1 rounded-sm px-1",
          since !== undefined && "animate-flash",
          tone === "error" && "text-error",
          tone === "warn" && !status && "text-warn",
        )}
      >
        {tone && status && (
          <span
            aria-hidden
            className={cn(
              "mr-1.5 inline-block size-1.5 rounded-full align-middle",
              tone === "error" ? "bg-error" : "bg-warn",
            )}
          />
        )}
        {parts.text}
        {parts.rest && (
          <span className="text-muted-foreground">{parts.rest}</span>
        )}
      </span>
    </div>
  );
}

function cellText(cell: Cell, column: Column, row: Row, now: number): string {
  if (column.kind === "age") {
    return row.created ? humanDuration(now - Date.parse(row.created)) : "";
  }
  return cell === null ? "" : String(cell);
}

function SkeletonRows({
  template,
  count,
}: {
  template: string;
  count: number;
}) {
  return (
    <div aria-busy>
      {Array.from({ length: 12 }, (_, i) => (
        <div
          key={i}
          className="grid items-center border-b border-border-micro"
          style={{
            height: ROW_HEIGHT,
            gridTemplateColumns: template || `repeat(${String(count)}, 1fr)`,
          }}
        >
          {Array.from({ length: count }, (_, j) => (
            <div key={j} className="px-2">
              <Skeleton
                className="h-2.5"
                style={{ width: `${String(40 + ((i * 7 + j * 13) % 45))}%` }}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function problem(
  status: ViewState,
  title: string,
  onRetry: () => void,
): ReactNode {
  const retry = { label: "Retry", onClick: onRetry };
  switch (status.state) {
    case "forbidden":
      return (
        <EmptyState
          icon={ShieldOff}
          title="Access denied"
          action={retry}
          className="flex-1"
        >
          <p>
            These credentials may not {status.verb} {status.resource}.
          </p>
        </EmptyState>
      );
    case "unauthorized":
      return (
        <EmptyState
          icon={KeyRound}
          title="Sign-in needed"
          action={retry}
          className="flex-1"
        >
          <p>The cluster rejected the credentials.</p>
        </EmptyState>
      );
    case "error":
      return (
        <EmptyState
          icon={CircleAlert}
          variant="error"
          title={`Could not load ${title.toLowerCase()}`}
          action={retry}
          className="flex-1"
        >
          <p className="max-w-md text-muted-foreground">
            {status.error.message}
          </p>
        </EmptyState>
      );
    default:
      return null;
  }
}
