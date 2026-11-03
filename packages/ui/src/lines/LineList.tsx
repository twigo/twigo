import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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

/**
 * The lines a list asks for: the last ones while it follows; paused, those
 * around the line it keeps in place, wherever lines before it moved it, or
 * a range until it has one.
 */
export type LineWindow =
  | { readonly tail: number }
  | { readonly start: number; readonly end: number }
  | {
      readonly around: string;
      readonly before: number;
      readonly after: number;
    };

/** Where a paused list stands: the key of its top line, and how far that line's start lies above the list's top. */
export interface LinePlace {
  readonly key: string;
  readonly offset: number;
}

const ROW = 19;
/** Lines asked for beyond the visible ones. */
const OVERSCAN = 40;
/** How far the top may move from the line a window was asked around before it asks again, so a scroll asks now and then. */
const DRIFT = 25;

/**
 * A virtualized list of text lines, of which only a window is loaded
 * (ARCHITECTURE 4.6): it follows the end until the person scrolls up, and
 * paused it keeps its top line in place by its key, however many lines
 * enter or leave before it, and when it shows again after a remount.
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
  fresh,
  place,
  reveal,
  onWindow,
  onFollowChange,
  onPlace,
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
  /** Lines that came while paused, on a button that follows again. */
  fresh: number;
  /** Where the list stood when it last paused, which it goes back to when it mounts paused. */
  place?: LinePlace | undefined;
  /** A line to scroll to, such as the current search match, each time its token changes; one not loaded is asked for around its key first. */
  reveal?: { readonly key: string; readonly token: number } | undefined;
  onWindow: (window: LineWindow) => void;
  onFollowChange: (follow: boolean) => void;
  /** Where the paused list stands as the person scrolls, for `place`. */
  onPlace?: (place: LinePlace) => void;
  /** Scopes the list's keys while it is mounted and routes the list commands to it, as a grid's. */
  register?: (element: HTMLElement, controller: ListController) => () => void;
  className?: string;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  /** The top line, as the list last saw it. */
  const anchor = useRef<
    { key: string; index: number; offset: number } | undefined
  >(undefined);
  /** The line the window was last asked around. */
  const [asked, setAsked] = useState<
    { key: string; index: number } | undefined
  >(place && !follow ? { key: place.key, index: -1 } : undefined);
  const restoring = useRef(place && !follow ? place : undefined);
  /** A line asked for to be revealed, until it is loaded. */
  const revealing = useRef<string | undefined>(undefined);
  const programmatic = useRef(false);
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => element,
    estimateSize: () => ROW,
    getItemKey: (index) => items[index - start]?.key ?? `#${String(index)}`,
    overscan: 10,
    initialRect: { width: 0, height: 400 },
  });
  const virtual = virtualizer.getVirtualItems();
  const first = virtual[0]?.index ?? 0;
  const last = virtual[virtual.length - 1]?.index ?? first;
  const rows = Math.ceil(height / ROW);

  /** Scrolls, and expects a scroll event only when the list moved. */
  const scroll = useEffectEvent((move: (to: HTMLElement) => void) => {
    if (!element) return;
    const before = element.scrollTop;
    move(element);
    programmatic.current = element.scrollTop !== before;
  });
  const offsetOf = useEffectEvent(
    (index: number) =>
      virtualizer.measurementsCache[index]?.start ?? index * ROW,
  );
  // A tab the panel hid comes back at the top without a scroll event.
  const shownAgain = useEffectEvent(() => {
    const held = anchor.current;
    if (!held || follow || !element) return;
    element.scrollTop = offsetOf(held.index) + held.offset;
  });

  useEffect(() => {
    if (!element) return;
    let shown = element.clientHeight > 0;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setHeight(entry.contentRect.height);
      const visible = entry.contentRect.height > 0;
      if (visible && !shown) shownAgain();
      shown = visible;
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [element]);

  useEffect(() => {
    if (follow) {
      onWindow({ tail: rows + OVERSCAN });
      return;
    }
    if (asked) {
      onWindow({ around: asked.key, before: OVERSCAN, after: rows + OVERSCAN });
      return;
    }
    onWindow({
      start: Math.max(0, first - OVERSCAN),
      end: last + OVERSCAN,
    });
  }, [follow, rows, asked, first, last, onWindow]);

  useEffect(() => {
    if (!follow) return;
    setAsked(undefined);
    restoring.current = undefined;
    revealing.current = undefined;
  }, [follow]);

  // Following, the end stays in view; paused, the top line stays put as
  // lines enter and leave before it.
  useLayoutEffect(() => {
    if (!element) return;
    if (follow) {
      if (total === 0) return;
      scroll(() => {
        virtualizer.scrollToIndex(total - 1, { align: "end" });
      });
      return;
    }
    const wanted = revealing.current;
    if (wanted) {
      const found = items.findIndex((item) => item.key === wanted);
      if (found >= 0) {
        revealing.current = undefined;
        restoring.current = undefined;
        const index = start + found;
        scroll(() => {
          virtualizer.scrollToIndex(index, { align: "center" });
        });
        return;
      }
    }
    const back = restoring.current;
    if (back) {
      const found = items.findIndex((item) => item.key === back.key);
      if (found >= 0) {
        restoring.current = undefined;
        const index = start + found;
        scroll((to) => {
          to.scrollTop = offsetOf(index) + back.offset;
        });
        anchor.current = { key: back.key, index, offset: back.offset };
        return;
      }
    }
    const held = anchor.current;
    if (!held) {
      // A range was asked for after a jump, or the kept place's line is
      // gone: once a top line is loaded, it holds the place, so drops before
      // it move nothing.
      const gone = back !== undefined && items.length > 0;
      if (gone) restoring.current = undefined;
      const top = virtualizer.getVirtualItemForOffset(element.scrollTop);
      const item = top && items[top.index - start];
      if (item && (!asked || gone)) {
        anchor.current = {
          key: item.key,
          index: top.index,
          offset: element.scrollTop - top.start,
        };
        setAsked({ key: item.key, index: top.index });
      }
      return;
    }
    const found = items.findIndex((item) => item.key === held.key);
    if (found < 0) return;
    const index = start + found;
    if (index === held.index) return;
    // Placed by its own start and offset: with wrap, the line that held its
    // old index is another height.
    scroll((to) => {
      to.scrollTop = offsetOf(index) + held.offset;
    });
    anchor.current = { ...held, index };
  }, [asked, element, follow, items, start, total, virtualizer]);

  useEffect(() => {
    virtualizer.measure();
  }, [wrap, virtualizer]);

  // Sizes are kept by line, so following with wrap would keep one for every
  // line that passed; the end is measured again at once.
  useEffect(() => {
    if (
      follow &&
      wrap &&
      virtualizer.itemSizeCache.size > 4 * (rows + OVERSCAN)
    )
      virtualizer.measure();
  }, [follow, wrap, items, rows, virtualizer]);

  const revealed = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!reveal || reveal.token === revealed.current) return;
    revealed.current = reveal.token;
    const found = items.findIndex((item) => item.key === reveal.key);
    if (found >= 0) {
      const index = start + found;
      scroll(() => {
        virtualizer.scrollToIndex(index, { align: "center" });
      });
      return;
    }
    revealing.current = reveal.key;
    anchor.current = undefined;
    setAsked({ key: reveal.key, index: -1 });
  }, [reveal, items, start, virtualizer]);

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
    const user = !programmatic.current;
    programmatic.current = false;
    const top = virtualizer.getVirtualItemForOffset(element.scrollTop);
    const item = top && items[top.index - start];
    if (item) {
      const offset = element.scrollTop - top.start;
      anchor.current = { key: item.key, index: top.index, offset };
      if (!follow) {
        onPlace?.({ key: item.key, offset });
        if (!asked || Math.abs(asked.index - top.index) > DRIFT)
          setAsked({ key: item.key, index: top.index });
      }
    } else if (!follow && user) {
      // A jump past what is loaded: the lines there are asked for by index.
      anchor.current = undefined;
      setAsked(undefined);
    }
    if (!user) return;
    restoring.current = undefined;
    revealing.current = undefined;
    const atEnd =
      element.scrollHeight - element.scrollTop - element.clientHeight < ROW;
    if (follow !== atEnd) onFollowChange(atEnd);
  };

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
      {!follow && fresh > 0 && (
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
