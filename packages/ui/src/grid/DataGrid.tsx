import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Ellipsis } from "lucide-react";
import { cn } from "../lib/cn";
import type { ListController } from "../lib/list";
import {
  ActionContextMenu,
  ActionDropdown,
  InlineActions,
  type Action,
  type ActionGroups,
} from "../components/actions";
import { Skeleton } from "../components/skeleton";
import { fitWidth } from "./fit";
import { HeaderCell, MarkBox } from "./header";
import type { GridColumn, GridItem, GridSort } from "./types";

export const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 28;
const MARK_WIDTH = 28;
const ACTIONS_WIDTH = 32;

export interface DataGridProps<R, G> {
  readonly label: string;
  readonly columns: readonly GridColumn[];
  /** Widths the user dragged or fitted, by column id. */
  readonly widths: Readonly<Record<string, number>>;
  readonly onResize: (column: string, width: number) => void;
  readonly sort: GridSort | null;
  readonly onSort: (sort: GridSort) => void;
  /** Items in the sequence: rows, and group headers when grouped. */
  readonly length: number;
  /** The item at an index, or undefined while it is not loaded. */
  readonly item: (index: number) => GridItem<R, G> | undefined;
  /** Where a loaded item sits, or -1. */
  readonly indexOf: (id: string) => number;
  /** The items on screen, start inclusive, end exclusive; stable identity. */
  readonly onRange: (start: number, end: number) => void;
  readonly cell: (row: R, column: GridColumn) => ReactNode;
  readonly group?: (group: G) => ReactNode;
  readonly onToggleGroup?: (id: string) => void;
  /** The selected row; the cursor follows it when it changes. */
  readonly selected: string | undefined;
  readonly onSelect: (id: string, row: R) => void;
  /** A click or Enter on a row. */
  readonly onActivate: (id: string, row: R) => void;
  /** Marked rows; without it the grid has no marks column. */
  readonly marked?: ReadonlySet<string>;
  readonly onMark?: (ids: readonly string[], marked: boolean) => void;
  /** The selected row's menu: a right click and its ⋯ select the row first. */
  readonly menu?: ActionGroups;
  /** Actions with icons that show on a hovered row, run on that row. */
  readonly inline?: readonly Action[];
  /** At the head of the actions column, such as the choice of columns. */
  readonly headerEnd?: ReactNode;
  /** Skeleton rows until the first rows come. */
  readonly loading: boolean;
  /** What shows when there are no items. */
  readonly empty?: ReactNode;
  /** When a cell last changed, to flash it; undefined when it did not. */
  readonly flash?: (id: string, column: string) => number | undefined;
  /** Registers the focusable grid for the list commands while it is mounted. */
  readonly register?: (
    element: HTMLElement,
    controller: ListController,
  ) => () => void;
}

/**
 * A virtualized grid of rows (ARCHITECTURE 4.4), controlled and
 * domain-free: its owner says what each item is and how a cell reads, and
 * keeps the selection, the marks, the sort and the widths.
 */
export function DataGrid<R, G>(props: DataGridProps<R, G>) {
  const {
    label,
    columns,
    widths,
    onResize,
    sort,
    onSort,
    length,
    item,
    indexOf,
    onRange,
    cell,
    group,
    onToggleGroup,
    selected,
    onSelect,
    onActivate,
    marked,
    onMark,
    menu = [],
    inline = [],
    headerEnd,
    loading,
    empty,
    flash,
    register,
  } = props;
  const ids = useId();
  const rowId = (index: number) => `${ids}-${String(index)}`;
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [cursor, setCursor] = useState(selected);
  const [followed, setFollowed] = useState(selected);
  if (selected !== followed) {
    setFollowed(selected);
    setCursor(selected);
  }

  const virtualizer = useVirtualizer({
    count: loading ? 0 : length,
    getScrollElement: () => element,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    initialRect: { width: 0, height: 600 },
    // The header scrolls with the rows, ahead of them, and covers them once it sticks.
    scrollMargin: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
  });
  const virtual = virtualizer.getVirtualItems();
  const first = virtual[0]?.index ?? 0;
  const last = virtual[virtual.length - 1]?.index ?? first;
  useEffect(() => {
    onRange(first, last + 1);
  }, [onRange, first, last]);

  const land = (target: GridItem<R, G>, marks?: readonly string[]) => {
    setCursor(target.id);
    if (target.type !== "row") {
      if (marks && marks.length > 0 && onMark) onMark(marks, true);
      return;
    }
    onSelect(target.id, target.data);
    if (marks && onMark)
      onMark(marks.includes(target.id) ? marks : [...marks, target.id], true);
  };

  // A keyboard move can land outside the loaded window; the cursor lands
  // once the item arrives. A marking move keeps the cursor it left, which
  // is marked too if it is still a row of the list when the move lands;
  // its place is loaded by then, to tell.
  const [wanted, setWanted] = useState<{
    index: number;
    from?: { id: string; index: number };
  }>();
  if (wanted !== undefined && wanted.index >= length) setWanted(undefined);
  const wantedItem = wanted === undefined ? undefined : item(wanted.index);
  const from = wanted?.from;
  const ready =
    wantedItem !== undefined &&
    (from === undefined ||
      from.index < 0 ||
      from.index >= length ||
      item(from.index) !== undefined);
  const latest = useRef({
    cursor,
    length,
    item,
    indexOf,
    onActivate,
    onToggleGroup,
    marked,
    onMark,
    land,
  });
  // Where the cursor was last seen, to move on from once it leaves the
  // window.
  const seen = useRef<{ id: string; index: number }>(undefined);
  useEffect(() => {
    latest.current = {
      cursor,
      length,
      item,
      indexOf,
      onActivate,
      onToggleGroup,
      marked,
      onMark,
      land,
    };
    const at = cursor === undefined ? -1 : indexOf(cursor);
    if (cursor !== undefined && at >= 0)
      seen.current = { id: cursor, index: at };
  });
  useEffect(() => {
    if (!wanted || !wantedItem || !ready) return;
    const { from: left } = wanted;
    if (left === undefined) {
      latest.current.land(wantedItem);
    } else {
      const { indexOf: find, item: at } = latest.current;
      const index = find(left.id);
      const origin = index < 0 ? undefined : at(index);
      latest.current.land(wantedItem, origin?.type === "row" ? [left.id] : []);
    }
    setWanted(undefined);
  }, [wanted, wantedItem, ready]);

  const controller = useMemo<ListController>(() => {
    const at = () => {
      const { cursor: id, indexOf: find } = latest.current;
      if (id === undefined) return -1;
      const found = find(id);
      if (found >= 0) return found;
      const last = seen.current;
      return last?.id === id ? last.index : -1;
    };
    const current = () => {
      const index = at();
      const target = index < 0 ? undefined : latest.current.item(index);
      return target?.id === latest.current.cursor ? target : undefined;
    };
    const go = (index: number, extend = false) => {
      const { length: count, cursor: id } = latest.current;
      if (count === 0) return;
      const target = Math.min(Math.max(index, 0), count - 1);
      virtualizer.scrollToIndex(target);
      setWanted({
        index: target,
        ...(extend && id !== undefined && { from: { id, index: at() } }),
      });
    };
    return {
      move(delta, extend) {
        const index = at();
        if (index >= 0) {
          go(index + delta, extend);
          return;
        }
        const top = virtualizer.getVirtualItemForOffset(
          (virtualizer.scrollOffset ?? 0) + HEADER_HEIGHT,
        );
        go(top?.index ?? 0, extend);
      },
      moveToEdge(edge) {
        go(edge === "first" ? 0 : latest.current.length - 1);
      },
      activate() {
        const target = current();
        if (target?.type === "group") latest.current.onToggleGroup?.(target.id);
        else if (target) latest.current.onActivate(target.id, target.data);
      },
      toggleMark() {
        const target = current();
        const { marked: marks, onMark: mark } = latest.current;
        if (target?.type === "row" && marks && mark)
          mark([target.id], !marks.has(target.id));
      },
      collapse() {
        const index = at();
        const target = current();
        if (target?.type === "group") {
          if (target.open) latest.current.onToggleGroup?.(target.id);
          return;
        }
        for (let up = index - 1; up >= 0; up--) {
          const above = latest.current.item(up);
          if (!above) return;
          if (above.type === "group") {
            go(up);
            return;
          }
        }
      },
      expand() {
        const target = current();
        if (target?.type === "group" && !target.open)
          latest.current.onToggleGroup?.(target.id);
      },
    };
  }, [virtualizer]);

  useEffect(() => {
    if (!element || !register) return;
    return register(element, controller);
  }, [element, register, controller]);

  const marking = marked !== undefined && onMark !== undefined;
  const widthOf = (column: GridColumn) => widths[column.id] ?? column.width;
  const grows = (column: GridColumn) =>
    column.grow === true && widths[column.id] === undefined;
  const filler = !columns.some(grows);
  const template = [
    ...(marking ? [`${String(MARK_WIDTH)}px`] : []),
    ...columns.map((column) =>
      grows(column)
        ? `minmax(${String(widthOf(column))}px, 1fr)`
        : `${String(widthOf(column))}px`,
    ),
    ...(filler ? ["minmax(0, 1fr)"] : []),
    `${String(ACTIONS_WIDTH)}px`,
  ].join(" ");
  const minWidth =
    (marking ? MARK_WIDTH : 0) +
    columns.reduce((sum, column) => sum + widthOf(column), 0) +
    ACTIONS_WIDTH;
  // The menu's trigger wraps every row, and opens the selected row's menu
  // unless a row prevents the event's default.
  const withoutMenu = (event: SyntheticEvent) => {
    event.preventDefault();
  };
  const anyMarked = (marked?.size ?? 0) > 0;
  const active = virtual.find(
    (at) => cursor !== undefined && item(at.index)?.id === cursor,
  );

  const rows = virtual.map((at) => {
    const target = item(at.index);
    const place = {
      transform: `translateY(${String(at.start - HEADER_HEIGHT)}px)`,
      height: ROW_HEIGHT,
    };
    if (!target) {
      return (
        <div
          key={`pending-${String(at.index)}`}
          role="row"
          aria-rowindex={at.index + 2}
          onContextMenu={withoutMenu}
          className="absolute inset-x-0 top-0 grid items-center border-b border-border-subtle"
          style={{ ...place, gridTemplateColumns: template }}
        >
          {marking && <div role="gridcell" />}
          {columns.map((column) => (
            <div key={column.id} role="gridcell" className="px-2">
              <Skeleton className="h-2.5 w-3/5" />
            </div>
          ))}
          {filler && <div role="gridcell" />}
          <div role="gridcell" />
        </div>
      );
    }
    const isCursor = target.id === cursor;
    if (target.type === "group") {
      const Chevron = target.open ? ChevronDown : ChevronRight;
      return (
        <div
          key={target.id}
          id={rowId(at.index)}
          role="row"
          aria-rowindex={at.index + 2}
          aria-expanded={target.open}
          aria-selected={!anyMarked && isCursor}
          data-cursor={isCursor || undefined}
          onClick={() => {
            setCursor(target.id);
            onToggleGroup?.(target.id);
          }}
          onContextMenu={withoutMenu}
          className={cn(
            "absolute inset-x-0 top-0 flex items-center border-b border-border bg-shell text-xs hover:bg-row-hover",
            isCursor && "group-focus/grid:bg-selected",
          )}
          style={place}
        >
          <div
            role="gridcell"
            className="flex min-w-0 flex-1 items-center gap-2 px-2"
          >
            <Chevron
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            {group?.(target.data)}
          </div>
        </div>
      );
    }
    const isMarked = marked?.has(target.id) === true;
    const tint = isMarked
      ? "bg-selected"
      : isCursor
        ? "bg-selected-unfocused group-focus/grid:bg-selected"
        : undefined;
    const select = () => {
      setCursor(target.id);
      onSelect(target.id, target.data);
    };
    return (
      <div
        key={target.id}
        id={rowId(at.index)}
        role="row"
        aria-rowindex={at.index + 2}
        aria-selected={anyMarked ? isMarked : isCursor}
        data-cursor={isCursor || undefined}
        onClick={() => {
          select();
          onActivate(target.id, target.data);
        }}
        onContextMenu={select}
        className={cn(
          "group/row absolute inset-x-0 top-0 grid items-center border-b border-border-subtle tabular-nums hover:bg-row-hover",
          tint,
          target.tone === "error" && "shadow-[inset_2px_0_0_var(--error)]",
          target.tone === "warn" && "shadow-[inset_2px_0_0_var(--warn)]",
        )}
        style={{ ...place, gridTemplateColumns: template }}
      >
        {marking && (
          <div
            role="gridcell"
            className={cn(
              "flex justify-center",
              !isMarked &&
                marked.size === 0 &&
                "opacity-0 group-hover/row:opacity-100 focus-within:opacity-100",
            )}
          >
            <MarkBox
              checked={isMarked}
              label={isMarked ? "Unmark row" : "Mark row"}
              onToggle={() => {
                onMark([target.id], !isMarked);
              }}
            />
          </div>
        )}
        {columns.map((column) => {
          const since = flash?.(target.id, column.id);
          return (
            <div
              key={column.id}
              role="gridcell"
              data-column={column.id}
              className={cn(
                "truncate px-2",
                column.align === "end" && "text-right",
              )}
            >
              <span
                key={since ?? "steady"}
                data-fit={column.id}
                className={cn(
                  "-mx-1 rounded-sm px-1",
                  since !== undefined && "animate-flash",
                )}
              >
                {cell(target.data, column)}
              </span>
            </div>
          );
        })}
        {filler && <div role="gridcell" />}
        <div role="gridcell" className="flex items-center justify-center">
          {menu.length > 0 && (
            <ActionDropdown actions={menu} label="Row actions" onOpen={select}>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                }}
                className={cn(
                  "flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none group-hover/row:opacity-100 hover:bg-row-hover hover:text-foreground focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)] data-[state=open]:bg-row-hover data-[state=open]:opacity-100",
                  isCursor && "opacity-100",
                )}
              >
                <Ellipsis aria-hidden className="size-4" />
              </button>
            </ActionDropdown>
          )}
          {inline.length > 0 && (
            <div
              className="absolute inset-y-0 hidden items-center bg-editor group-hover/row:flex"
              style={{ right: ACTIONS_WIDTH }}
            >
              <div
                className={cn(
                  "flex h-full items-center bg-row-hover pl-2",
                  tint,
                )}
              >
                <InlineActions
                  actions={inline.map((action) => ({
                    ...action,
                    run: () => {
                      select();
                      action.run();
                    },
                  }))}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  });

  return (
    <div
      ref={setElement}
      role="grid"
      tabIndex={0}
      aria-label={label}
      aria-rowcount={length + 1}
      aria-multiselectable={marking || undefined}
      aria-activedescendant={active && rowId(active.index)}
      className="group/grid h-full min-h-0 overflow-auto outline-none"
    >
      <div
        role="row"
        aria-rowindex={1}
        className="group/header sticky top-0 z-10 grid items-center border-b border-border bg-editor text-xs text-muted-foreground"
        style={{
          gridTemplateColumns: template,
          minWidth,
          height: HEADER_HEIGHT,
        }}
      >
        {marking && (
          <div role="columnheader" className="flex justify-center">
            {marked.size > 0 && (
              <MarkBox
                checked={false}
                partial
                label="Clear marks"
                onToggle={() => {
                  onMark([...marked], false);
                }}
              />
            )}
          </div>
        )}
        {columns.map((column) => (
          <HeaderCell
            key={column.id}
            column={column}
            width={widthOf(column)}
            sort={sort}
            onSort={onSort}
            onResize={(width) => {
              onResize(column.id, width);
            }}
            onFit={() => {
              if (element) onResize(column.id, fitWidth(element, column.id));
            }}
          />
        ))}
        {filler && <div role="columnheader" />}
        <div role="columnheader" className="flex items-center justify-center">
          {headerEnd}
        </div>
      </div>
      {loading ? (
        <SkeletonRows
          template={template}
          columns={columns.length}
          marking={marking}
        />
      ) : length === 0 ? (
        empty
      ) : (
        <ActionContextMenu actions={menu}>
          <div
            className="relative"
            style={{ height: virtualizer.getTotalSize(), minWidth }}
          >
            {rows}
          </div>
        </ActionContextMenu>
      )}
    </div>
  );
}

/** A grid's skeleton before its columns are known. */
export function GridSkeleton() {
  return (
    <SkeletonRows
      template="minmax(0,2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)"
      columns={4}
      marking={false}
    />
  );
}

function SkeletonRows({
  template,
  columns,
  marking,
}: {
  template: string;
  columns: number;
  marking: boolean;
}) {
  return (
    <div aria-busy>
      {Array.from({ length: 12 }, (_, row) => (
        <div
          key={row}
          className="grid items-center border-b border-border-subtle"
          style={{ height: ROW_HEIGHT, gridTemplateColumns: template }}
        >
          {marking && <div />}
          {Array.from({ length: columns }, (_, column) => (
            <div key={column} className="px-2">
              <Skeleton
                className="h-2.5"
                style={{
                  width: `${String(40 + ((row * 7 + column * 13) % 45))}%`,
                }}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
