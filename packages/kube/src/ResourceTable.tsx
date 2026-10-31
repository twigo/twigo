import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { cellTone } from "./tones";
import { useListView } from "./useListView";

const ROW_HEIGHT = 26;

/** States in which Rust sends rows; the loading states show skeletons. */
const SHOWS_ROWS = new Set<ViewState["state"]>(["ready", "relisting", "stale"]);

interface Props {
  backend: Backend;
  space: string;
  gvr: Gvr;
  /** Plural, as the explorer names the kind: "Pods". */
  title: string;
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
  onRetry,
}: Props & { onRetry: () => void }) {
  const [sort, setSort] = useState<Sort | null>(null);
  const [selected, setSelected] = useState<RowId>();
  const { snapshot, flash, setWindow } = useListView(backend, {
    space,
    gvr,
    namespaces: [],
    labelSelector: null,
    text: null,
    sort,
  });
  const now = useNow(1000);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { status } = snapshot;
  const showsRows = SHOWS_ROWS.has(status.state);
  const columns = snapshot.columns
    .map((column, index) => ({ ...column, index }))
    .filter((column) => column.priority === 0);

  const virtualizer = useVirtualizer({
    count: showsRows ? snapshot.total : 0,
    getScrollElement: () => scrollRef.current,
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

  const Icon = kindIcon(gvr);
  const template = columns.map(width).join(" ");

  return (
    <section className="flex h-full min-h-0 flex-col bg-editor">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        <Icon className="size-4 text-muted-foreground" />
        <h2 className="font-medium">{title}</h2>
        {showsRows && (
          <span className="text-muted-foreground tabular-nums">
            {snapshot.total.toLocaleString("en")}
          </span>
        )}
        <StateBadge status={status} />
      </header>
      {problem(status, title, onRetry) ?? (
        <div
          ref={scrollRef}
          role="grid"
          aria-rowcount={snapshot.total + 1}
          className="min-h-0 flex-1 overflow-auto"
        >
          <div
            role="row"
            aria-rowindex={1}
            className="sticky top-0 z-10 grid h-7 items-center border-b border-border-subtle bg-editor text-xs text-muted-foreground"
            style={{ gridTemplateColumns: template }}
          >
            {columns.map((column) => (
              <HeaderCell
                key={column.name}
                column={column}
                sort={sort}
                onSort={setSort}
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
              style={{ height: virtualizer.getTotalSize() }}
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
                    }}
                    className={cn(
                      "absolute inset-x-0 grid items-center border-b border-border-micro tabular-nums hover:bg-row-hover",
                      row !== undefined && row.id === selected && "bg-selected",
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

function rowAt(snapshot: ListSnapshot, index: number): Row | undefined {
  const id = snapshot.ids[index - snapshot.start];
  return id === undefined ? undefined : snapshot.rows.get(id);
}

type IndexedColumn = Column & { index: number };

const WIDTHS: Readonly<Record<string, string>> = {
  Name: "minmax(16rem, 2.5fr)",
  Namespace: "minmax(8rem, 1fr)",
  Context: "minmax(7rem, 0.8fr)",
  Ready: "4.5rem",
  Status: "minmax(10rem, 1fr)",
  Restarts: "minmax(7rem, 0.6fr)",
};

function width(column: Column): string {
  if (column.kind === "age") return "4.5rem";
  return WIDTHS[column.name] ?? "minmax(6rem, 1fr)";
}

function alignEnd(column: Column): boolean {
  return (
    column.kind === "age" ||
    column.kind === "integer" ||
    column.kind === "number"
  );
}

function HeaderCell({
  column,
  sort,
  onSort,
}: {
  column: IndexedColumn;
  sort: Sort | null;
  onSort: (sort: Sort) => void;
}) {
  const active = sort?.column === column.name;
  const Arrow = active && sort.descending ? ArrowDown : ArrowUp;
  return (
    <button
      type="button"
      role="columnheader"
      aria-sort={
        active ? (sort.descending ? "descending" : "ascending") : "none"
      }
      onClick={() => {
        onSort({ column: column.name, descending: active && !sort.descending });
      }}
      className={cn(
        "flex h-full items-center gap-1 px-2 text-left font-medium hover:text-foreground",
        alignEnd(column) && "flex-row-reverse text-right",
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
  const since = flash?.since(row.id, column.index);
  return (
    <div
      role="gridcell"
      className={cn(
        "truncate px-2",
        alignEnd(column) && "text-right",
        column.kind === "age" && "text-muted-foreground",
        text === "<none>" && "text-muted-foreground-2",
      )}
    >
      <span
        key={since ?? "steady"}
        className={cn(
          "-mx-1 rounded-sm px-1",
          since !== undefined && "animate-flash",
          tone === "error" && "text-error",
        )}
      >
        {tone && (
          <span
            aria-hidden
            className={cn(
              "mr-1.5 inline-block size-1.5 rounded-full align-middle",
              tone === "error" ? "bg-error" : "bg-warn",
            )}
          />
        )}
        {text}
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

function StateBadge({ status }: { status: ViewState }) {
  const label = badge(status);
  if (!label) return null;
  return (
    <span
      className={cn(
        "ml-auto text-xs text-muted-foreground",
        status.state === "stale" && "text-warn",
      )}
    >
      {label}
    </span>
  );
}

function badge(status: ViewState): string | undefined {
  switch (status.state) {
    case "queued":
      return "Waiting for a stream slot";
    case "connecting":
      return "Connecting…";
    case "syncing":
      return `Loading · ${status.loaded.toLocaleString("en")}`;
    case "relisting":
      return "Relisting…";
    case "stale":
      return "No updates · reconnecting";
    default:
      return undefined;
  }
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

function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, ms);
    return () => {
      clearInterval(timer);
    };
  }, [ms]);
  return now;
}
