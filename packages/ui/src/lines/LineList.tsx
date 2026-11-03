import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";
import type { ListController } from "../lib/list";
import type { Tone } from "../lib/tone";
import { StyledText, type TextMark, type TextRun } from "./StyledText";

/** One line of text, such as a log's. */
export interface TextLine {
  readonly kind: "line";
  /** Its own while it is listed, so the list keeps its place as lines come and go before it. */
  readonly key: string;
  /** A narrow column before the time, such as the generated part of a pod's name. */
  readonly tag: string;
  /** Draws the tag in the brand's colour, as a pod that just joined. */
  readonly tagAccent?: boolean;
  readonly time: string;
  /** A warning or an error tints the line and marks its edge. */
  readonly tone?: "warn" | "error";
  readonly text: string;
  readonly runs: readonly TextRun[];
  readonly marks: readonly TextMark[];
}

/** A line between lines that says what happened: a container ended, a pod joined. */
export interface MarkerLine {
  readonly kind: "marker";
  readonly key: string;
  readonly icon: LucideIcon;
  readonly tone?: Tone;
  readonly tag?: string;
  readonly text: string;
}

export type LineItem = TextLine | MarkerLine;

/** The lines a list asks for: the last ones while it follows, else a range. */
export type LineWindow =
  { readonly tail: number } | { readonly start: number; readonly end: number };

const ROW = 19;
/** Lines asked for beyond the visible ones, in blocks, so a scroll asks again only now and then. */
const OVERSCAN = 40;
const BLOCK = 50;

/**
 * A virtualized list of text lines, of which only a window is loaded
 * (ARCHITECTURE 4.6): it follows the end until the person scrolls up,
 * counts what came meanwhile, and keeps its place by the lines' keys as
 * lines enter and leave before it.
 */
export function LineList({
  label,
  total,
  start,
  items,
  follow,
  wrap,
  timestamps,
  tagWidth = 6,
  reveal,
  onWindow,
  onFollowChange,
  register,
  className,
}: {
  label: string;
  total: number;
  /** The index of `items[0]`. */
  start: number;
  items: readonly LineItem[];
  follow: boolean;
  wrap: boolean;
  timestamps: boolean;
  /** The tag column's width in characters. */
  tagWidth?: number;
  /** An index to scroll to, such as the current search match, each time its token changes. */
  reveal?: { readonly index: number; readonly token: number } | undefined;
  onWindow: (window: LineWindow) => void;
  onFollowChange: (follow: boolean) => void;
  /** Scopes the list's keys while it is mounted and routes the list commands to it, as a grid's. */
  register?: (element: HTMLElement, controller: ListController) => () => void;
  className?: string;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  const anchor = useRef<{ key: string; index: number } | undefined>(undefined);
  const programmatic = useRef(false);
  const [paused, setPaused] = useState(total);
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => element,
    estimateSize: () => ROW,
    overscan: 10,
    initialRect: { width: 0, height: 400 },
  });
  const virtual = virtualizer.getVirtualItems();
  const first = virtual[0]?.index ?? 0;
  const last = virtual[virtual.length - 1]?.index ?? first;

  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHeight(entry.contentRect.height);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [element]);

  useEffect(() => {
    if (follow) {
      onWindow({ tail: Math.ceil(height / ROW) + OVERSCAN });
      return;
    }
    onWindow({
      start: Math.max(0, Math.floor((first - OVERSCAN) / BLOCK) * BLOCK),
      end: Math.ceil((last + OVERSCAN) / BLOCK) * BLOCK,
    });
  }, [follow, height, first, last, onWindow]);

  // Following, the end stays in view; paused, the line at the top stays put
  // as lines enter and leave before it.
  useLayoutEffect(() => {
    if (!element) return;
    if (follow) {
      if (total === 0) return;
      programmatic.current = true;
      virtualizer.scrollToIndex(total - 1, { align: "end" });
      return;
    }
    const held = anchor.current;
    if (!held) return;
    const found = items.findIndex((item) => item.key === held.key);
    if (found < 0) return;
    const index = start + found;
    if (index === held.index) return;
    const offset = (at: number) =>
      virtualizer.measurementsCache[at]?.start ?? at * ROW;
    programmatic.current = true;
    element.scrollTop += offset(index) - offset(held.index);
    anchor.current = { key: held.key, index };
  }, [element, follow, items, start, total, virtualizer]);

  const revealed = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!reveal || reveal.token === revealed.current) return;
    revealed.current = reveal.token;
    programmatic.current = true;
    virtualizer.scrollToIndex(reveal.index, { align: "center" });
  }, [reveal, virtualizer]);

  useEffect(() => {
    if (follow) setPaused(total);
  }, [follow, total]);

  useEffect(() => {
    if (!element || !register) return;
    return register(element, {
      move: (delta) => {
        if (delta < 0) onFollowChange(false);
        element.scrollTop += delta * ROW;
      },
      moveToEdge: (edge) => {
        if (edge === "last") {
          onFollowChange(true);
          return;
        }
        onFollowChange(false);
        element.scrollTop = 0;
      },
      activate: () => undefined,
    });
  }, [element, register, onFollowChange]);

  const onScroll = () => {
    if (!element) return;
    const top = virtualizer
      .getVirtualItems()
      .find((item) => item.start >= element.scrollTop);
    const item = top && items[top.index - start];
    if (item) anchor.current = { key: item.key, index: top.index };
    if (programmatic.current) {
      programmatic.current = false;
      return;
    }
    const atEnd =
      element.scrollHeight - element.scrollTop - element.clientHeight < ROW;
    if (follow !== atEnd) onFollowChange(atEnd);
  };

  const fresh = follow ? 0 : Math.max(0, total - paused);
  return (
    <div className={cn("relative min-h-0", className)}>
      <div
        ref={setElement}
        role="log"
        aria-label={label}
        tabIndex={0}
        onScroll={onScroll}
        onWheel={(event) => {
          if (follow && event.deltaY < 0) onFollowChange(false);
        }}
        className="h-full overflow-auto py-1 font-mono text-xs leading-[19px] outline-none focus-visible:shadow-[inset_var(--focus-ring)]"
      >
        <div
          className={cn("relative", !wrap && "w-max min-w-full")}
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtual.map((row) => {
            const item = items[row.index - start];
            return (
              <div
                key={row.key}
                data-index={row.index}
                ref={wrap ? virtualizer.measureElement : undefined}
                className="absolute left-0 w-full"
                style={{ transform: `translateY(${String(row.start)}px)` }}
              >
                {item === undefined ? (
                  <div style={{ height: ROW }} />
                ) : item.kind === "marker" ? (
                  <Marker item={item} />
                ) : (
                  <Line
                    item={item}
                    wrap={wrap}
                    timestamps={timestamps}
                    tagWidth={tagWidth}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {fresh > 0 && (
        <button
          type="button"
          onClick={() => {
            onFollowChange(true);
          }}
          className="absolute right-4 bottom-3 inline-flex h-6.5 items-center gap-1.5 rounded-full bg-brand px-2.5 text-xs text-brand-foreground shadow-lg outline-none focus-visible:shadow-[var(--focus-ring)]"
        >
          <ArrowDown aria-hidden className="size-3" />
          {fresh.toLocaleString("en")} new {fresh === 1 ? "line" : "lines"}
        </button>
      )}
    </div>
  );
}

function Line({
  item,
  wrap,
  timestamps,
  tagWidth,
}: {
  item: TextLine;
  wrap: boolean;
  timestamps: boolean;
  tagWidth: number;
}) {
  return (
    <div
      style={{
        gridTemplateColumns: `${String(tagWidth)}ch ${timestamps ? "12ch " : ""}minmax(0, 1fr)`,
      }}
      className={cn(
        "grid gap-x-2.5 pr-3 pl-3",
        item.tone === "warn" && "bg-warn/7 shadow-[inset_2px_0_0_var(--warn)]",
        item.tone === "error" &&
          "bg-error/8 shadow-[inset_2px_0_0_var(--error)]",
      )}
    >
      <span
        className={cn(
          "truncate",
          item.tagAccent ? "text-brand" : "text-muted-foreground",
        )}
      >
        {item.tag}
      </span>
      {timestamps && (
        <span className="text-muted-foreground-2 tabular-nums">
          {item.time}
        </span>
      )}
      <span
        className={wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre"}
      >
        <StyledText text={item.text} runs={item.runs} marks={item.marks} />
      </span>
    </div>
  );
}

function Marker({ item }: { item: MarkerLine }) {
  const Icon = item.icon;
  return (
    <div className="flex h-[19px] items-center gap-2 border-y border-dashed border-border px-3 font-sans text-xs text-muted-foreground">
      <Icon
        aria-hidden
        className={cn(
          "size-3 shrink-0",
          item.tone === "error" && "text-error",
          item.tone === "warn" && "text-warn-foreground",
        )}
      />
      {item.tag && <span className="font-mono">{item.tag}</span>}
      <span className="truncate">{item.text}</span>
    </div>
  );
}
