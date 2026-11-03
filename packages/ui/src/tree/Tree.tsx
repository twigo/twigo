import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";
import type { ListController } from "../lib/list";

/** A row of a tree as it shows: the owner flattens what is open. */
export interface TreeRow {
  readonly id: string;
  /** The row it sits under, which Left goes back to. */
  readonly parent?: string;
  readonly depth: number;
  readonly label: ReactNode;
  readonly icon?: LucideIcon;
  /** Present on a row that folds: whether it is open. */
  readonly open?: boolean;
  /** At the row's end, such as a count. */
  readonly trailing?: ReactNode;
  /** A small label over a run of rows, which the cursor passes by. */
  readonly heading?: boolean;
}

/**
 * A tree of 22 px rows (ARCHITECTURE 4.9): a click on a folding row folds
 * it, on a leaf opens it, a double click keeps what it opened. The list
 * commands move through it while it has the focus.
 */
export function Tree({
  label,
  rows,
  active,
  onOpen,
  onToggle,
  register,
}: {
  label: string;
  rows: readonly TreeRow[];
  /** The row of what is open elsewhere, such as the active editor. */
  active?: string;
  onOpen: (id: string, keep: boolean) => void;
  onToggle: (id: string) => void;
  register?: (element: HTMLElement, controller: ListController) => () => void;
}) {
  const ids = useId();
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [cursor, setCursor] = useState<string>();
  const at = Math.max(
    0,
    rows.findIndex((row) => row.id === (cursor ?? active)),
  );
  const current = rows[at];
  const rowId = (index: number) => `${ids}-${String(index)}`;

  const latest = useRef({ rows, at, onOpen, onToggle });
  useEffect(() => {
    latest.current = { rows, at, onOpen, onToggle };
  });
  const controller = useMemo<ListController>(() => {
    const moveTo = (index: number, step: number) => {
      const { rows: shown } = latest.current;
      let target = Math.min(Math.max(index, 0), shown.length - 1);
      while (shown[target]?.heading) target += step;
      const row = shown[target];
      if (row) setCursor(row.id);
    };
    const row = () => latest.current.rows[latest.current.at];
    return {
      move(delta) {
        moveTo(latest.current.at + delta, delta < 0 ? -1 : 1);
      },
      moveToEdge(edge) {
        moveTo(
          edge === "first" ? 0 : latest.current.rows.length - 1,
          edge === "first" ? 1 : -1,
        );
      },
      activate() {
        const target = row();
        if (!target || target.heading) return;
        if (target.open !== undefined) latest.current.onToggle(target.id);
        else latest.current.onOpen(target.id, false);
      },
      collapse() {
        const target = row();
        if (target?.open) latest.current.onToggle(target.id);
        else if (target?.parent !== undefined) setCursor(target.parent);
      },
      expand() {
        const target = row();
        const { rows: shown, at: index } = latest.current;
        if (target?.open === false) latest.current.onToggle(target.id);
        else if (target?.open && shown[index + 1]?.parent === target.id)
          moveTo(index + 1, 1);
      },
    };
  }, []);

  useEffect(() => {
    if (!element || !register) return;
    return register(element, controller);
  }, [element, register, controller]);

  useEffect(() => {
    document
      .getElementById(`${ids}-${String(at)}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [ids, at]);

  return (
    <div
      ref={setElement}
      role="tree"
      tabIndex={0}
      aria-label={label}
      aria-activedescendant={
        current && !current.heading ? rowId(at) : undefined
      }
      className="group/tree h-full overflow-auto pb-2 outline-none"
    >
      {rows.map((row, index) =>
        row.heading ? (
          <div
            key={row.id}
            id={rowId(index)}
            role="presentation"
            className="flex h-6 items-end px-3 pb-1 text-[11px] font-semibold text-muted-foreground"
          >
            {row.label}
          </div>
        ) : (
          <TreeItem
            key={row.id}
            id={rowId(index)}
            row={row}
            active={row.open === undefined && row.id === active}
            cursor={index === at}
            onClick={() => {
              setCursor(row.id);
              if (row.open !== undefined) onToggle(row.id);
              else onOpen(row.id, false);
            }}
            onDoubleClick={() => {
              if (row.open === undefined) onOpen(row.id, true);
            }}
          />
        ),
      )}
    </div>
  );
}

function TreeItem({
  id,
  row,
  active,
  cursor,
  onClick,
  onDoubleClick,
}: {
  id: string;
  row: TreeRow;
  active: boolean;
  cursor: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}): ReactNode {
  const Chevron = row.open ? ChevronDown : ChevronRight;
  const folds = row.open !== undefined;
  return (
    <div
      id={id}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={folds ? row.open : undefined}
      aria-selected={active}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      style={{ paddingLeft: (folds ? 8 : 12) + row.depth * 16 }}
      className={cn(
        "relative flex h-[22px] items-center gap-1 pr-2 text-[13px] select-none",
        active ? "bg-selected-unfocused" : "hover:bg-row-hover",
        cursor &&
          "group-focus/tree:bg-selected group-focus/tree:hover:bg-selected",
      )}
    >
      {Array.from({ length: row.depth }, (_, level) => (
        <span
          key={level}
          aria-hidden
          style={{ left: 15.5 + level * 16 }}
          className="pointer-events-none absolute inset-y-0 w-px bg-border"
        />
      ))}
      {folds && (
        <Chevron
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground"
        />
      )}
      {row.icon && (
        <row.icon
          aria-hidden
          className="mr-0.5 size-4 shrink-0 text-muted-foreground"
        />
      )}
      <span className="min-w-0 flex-1 truncate">{row.label}</span>
      {row.trailing}
    </div>
  );
}
