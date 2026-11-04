import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
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

/** Where the line a window was asked around stands: at its index, or where it would stand if the view kept it. */
export interface LineAround {
  readonly key: string;
  readonly index: number;
}

const ROW = 19;
/** Lines asked for beyond the visible ones. */
const OVERSCAN = 40;
/** How far the top may move from the line a window was asked around before it asks again, so a scroll asks now and then. */
const DRIFT = 25;

/**
 * What a list does about its place, each with the window it asks for
 * (ARCHITECTURE 4.6): following, it keeps the end in view and asks for the
 * tail; a seek wants a line that is not loaded yet, a place to go back to
 * or a line to reveal, and asks around it; a hold keeps a line `offset` px
 * above the top wherever lines before it move it, and asks around `asked`;
 * after a jump past the loaded lines it asks for the visible ones by index
 * until its top line is loaded.
 */
type Mode =
  | { readonly kind: "follow" }
  | {
      readonly kind: "seek";
      readonly key: string;
      readonly offset: number | "centre";
    }
  | {
      readonly kind: "hold";
      readonly key: string;
      readonly offset: number;
      readonly asked: string;
    }
  | { readonly kind: "jump" };

const FOLLOW: Mode = { kind: "follow" };
const JUMP: Mode = { kind: "jump" };

/** Where a key sends the list: a page up or down, or an edge. */
type Move = "up" | "down" | "first" | "last";

/**
 * The keys that scroll a focused list natively, which the list moves
 * itself, at once: WebKit animates a key's scroll and stops it at the
 * list's next write of `scrollTop`.
 */
function moveOf({
  key,
  altKey,
  ctrlKey,
  metaKey,
  shiftKey,
}: KeyboardEvent): Move | undefined {
  if (ctrlKey || (altKey && metaKey)) return undefined;
  if (key === " ")
    return altKey || metaKey ? undefined : shiftKey ? "up" : "down";
  if (shiftKey) return undefined;
  switch (key) {
    case "PageUp":
      return altKey || metaKey ? undefined : "up";
    case "PageDown":
      return altKey || metaKey ? undefined : "down";
    case "ArrowUp":
      return metaKey ? "first" : altKey ? "up" : undefined;
    case "ArrowDown":
      return metaKey ? "last" : altKey ? "down" : undefined;
    default:
      return undefined;
  }
}

/** The keys of lines no longer loaded, by index, and the window they were taken from. */
interface Loaded {
  readonly start: number;
  readonly items: readonly LineItem[];
  readonly left: ReadonlyMap<number, string>;
}

/**
 * The lines that left the loaded ones, by the index they stand at now, so
 * their rows keep the sizes they were measured at and a new window does
 * not move the lines below them: the window before's and those it kept,
 * each moved as far as the nearest line both windows hold, within `reach`
 * of the loaded lines.
 */
function leftOf(
  was: Loaded,
  start: number,
  items: readonly LineItem[],
  reach: number,
  total: number,
): ReadonlyMap<number, string> {
  const now = new Map(items.map((item, at) => [item.key, start + at]));
  const first = was.items.findIndex((item) => now.has(item.key));
  let last = was.items.length - 1;
  while (last > first && !now.has(was.items[last]?.key ?? "")) last--;
  const moved = (at: number) => {
    const item = was.items[at];
    return item && (now.get(item.key) ?? 0) - (was.start + at);
  };
  const above = moved(first);
  const below = moved(last);
  if (above === undefined || below === undefined) return NONE;
  const end = start + items.length;
  const left = new Map<number, string>();
  const keep = (index: number, key: string) => {
    const at = index + (index < was.start + first ? above : below);
    if (now.has(key) || (at >= start && at < end)) return;
    if (at >= Math.max(0, start - reach) && at < Math.min(total, end + reach))
      left.set(at, key);
  };
  for (const [index, key] of was.left) keep(index, key);
  was.items.forEach((item, at) => {
    keep(was.start + at, item.key);
  });
  return left;
}

const NONE: ReadonlyMap<number, string> = new Map();

/** Whether a window holds the lines it held, by its bounds: the items are made anew on every render. */
function sameLines(
  was: Loaded,
  start: number,
  items: readonly LineItem[],
): boolean {
  return (
    was.start === start &&
    was.items.length === items.length &&
    was.items[0]?.key === items[0]?.key &&
    was.items[was.items.length - 1]?.key === items[items.length - 1]?.key
  );
}

/** What a page keeps in view of the one before, about what the browsers keep. */
const OVERLAP = 2 * ROW;

function askedBy(mode: Mode): string | undefined {
  switch (mode.kind) {
    case "seek":
      return mode.key;
    case "hold":
      return mode.asked;
    default:
      return undefined;
  }
}

const NEVER = () => false;

function maxOf(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

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
  around,
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
  /** Present when the items answer a window asked around a line. */
  around?: LineAround | undefined;
  follow: boolean;
  wrap: boolean;
  timestamps: boolean;
  /** The tag column's width in characters. */
  tagWidth?: number;
  /** Lines that came while paused, on a button that follows again. */
  fresh: number;
  /** Where the list stood or was going when it last paused, which it goes back to when it mounts paused. */
  place?: LinePlace | undefined;
  /**
   * A line to scroll to, such as a search step's match, each time its
   * token changes while the list is paused, after the one it mounts with;
   * one not loaded is asked for around its key first.
   */
  reveal?: { readonly key: string; readonly token: number } | undefined;
  onWindow: (window: LineWindow) => void;
  onFollowChange: (follow: boolean) => void;
  /** Where the paused list stands, or the line it reveals, for `place`. */
  onPlace?: (place: LinePlace) => void;
  /** Scopes the list's keys while it is mounted and routes the list commands to it, as a grid's. */
  register?: (element: HTMLElement, controller: ListController) => () => void;
  className?: string;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  const [initial] = useState<Mode>(() =>
    follow
      ? FOLLOW
      : place
        ? { kind: "seek", key: place.key, offset: place.offset }
        : JUMP,
  );
  const mode = useRef(initial);
  /** The line the window is asked around, so that it is asked again when it changes. */
  const [asked, setAsked] = useState(askedBy(initial));
  /** A reveal it mounts with was done before it mounted. */
  const revealed = useRef(reveal?.token);
  /** Follows again only when `follow` turns on, not while a pause the person made is on its way to it. */
  const followed = useRef(follow);
  /** Where the list's own writes left `scrollTop`, as read back, or where the person's scroll it took in did: a scroll elsewhere is the person's. */
  const known = useRef(0);
  /** Hidden, the list has no layout to place its lines in; shown again, it places them anew. */
  const hidden = useRef(false);
  const rows = Math.ceil(height / ROW);
  const [loaded, setLoaded] = useState<Loaded>({ start, items, left: NONE });
  if (!sameLines(loaded, start, items))
    setLoaded({
      start,
      items,
      left: leftOf(
        loaded,
        start,
        items,
        follow ? rows + OVERSCAN : total,
        total,
      ),
    });
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => element,
    estimateSize: () => ROW,
    getItemKey: (index) =>
      items[index - start]?.key ??
      loaded.left.get(index) ??
      `#${String(index)}`,
    overscan: 10,
    initialRect: { width: 0, height: 400 },
  });
  // The list scrolls itself (ARCHITECTURE 4.6): virtual-core would move it
  // by the size a row above the top was measured at.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = NEVER;
  const virtual = virtualizer.getVirtualItems();
  const size = virtualizer.getTotalSize();
  const first = virtual[0]?.index ?? 0;
  const last = virtual[virtual.length - 1]?.index ?? first;

  const enter = (next: Mode) => {
    mode.current = next;
    setAsked(askedBy(next));
  };
  const hold = (key: string, offset: number, ask: string) => {
    enter({ kind: "hold", key, offset, asked: ask });
    onPlace?.({ key, offset });
  };
  const indexOf = (key: string) => {
    const found = items.findIndex((item) => item.key === key);
    return found < 0 ? undefined : start + found;
  };
  const placed = (key: string) =>
    indexOf(key) ?? (around?.key === key ? around.index : undefined);
  // Placed by its own start: with wrap, the line that held its old index
  // is another height.
  const startOf = (index: number) =>
    virtualizer.measurementsCache[index]?.start ?? index * ROW;
  const topLine = (scroller: HTMLElement) => {
    const top = virtualizer.getVirtualItemForOffset(scroller.scrollTop);
    const item = top && items[top.index - start];
    return item
      ? {
          key: item.key,
          index: top.index,
          offset: scroller.scrollTop - top.start,
        }
      : undefined;
  };
  const write = (scroller: HTMLElement, top: number) => {
    if (Math.abs(scroller.scrollTop - top) >= 1) scroller.scrollTop = top;
    known.current = scroller.scrollTop;
  };
  /** How far the person scrolled since the list last knew where it stood; a browser that cut the list short at its end did not. */
  const unseen = (scroller: HTMLElement) => {
    const top = scroller.scrollTop;
    if (Math.abs(top - known.current) < 1) return 0;
    if (top < known.current && Math.abs(top - maxOf(scroller)) < 1) {
      known.current = top;
      return 0;
    }
    return top - known.current;
  };
  // While `follow` is on, as when a pause the person made has not reached
  // it yet, no change of it is coming to follow by.
  const followAgain = () => {
    onFollowChange(true);
    if (follow) enter(FOLLOW);
  };
  // Following, the person's scroll away from the end pauses; paused, one
  // down to the end follows again. Otherwise the list holds the line now on
  // top.
  const personal = (scroller: HTMLElement, from: number) => {
    const top = scroller.scrollTop;
    known.current = top;
    const now = mode.current;
    if (now.kind === "follow") {
      if (maxOf(scroller) - top < ROW) return;
      onFollowChange(false);
    } else if (top > from && maxOf(scroller) - top < ROW) {
      followAgain();
      return;
    }
    const line = topLine(scroller);
    if (!line) {
      enter(JUMP);
      return;
    }
    let ask = line.key;
    if (now.kind === "hold") {
      const was = indexOf(now.asked);
      if (was !== undefined && Math.abs(was - line.index) <= DRIFT)
        ask = now.asked;
    }
    hold(line.key, line.offset, ask);
  };
  // The person's key moves the list at once, as their scroll; one down at
  // the end follows again.
  const go = (scroller: HTMLElement, top: number) => {
    const from = known.current;
    scroller.scrollTop = top;
    if (unseen(scroller) !== 0) personal(scroller, from);
    else if (top > from && maxOf(scroller) - scroller.scrollTop < ROW)
      followAgain();
  };
  const move = (scroller: HTMLElement, to: Move) => {
    if (to === "last") followAgain();
    else if (to === "first") go(scroller, 0);
    else
      go(
        scroller,
        scroller.scrollTop +
          (to === "down" ? 1 : -1) * (scroller.clientHeight - OVERLAP),
      );
  };

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

  const ask = useEffectEvent(() => {
    const now = mode.current;
    if (now.kind === "follow") onWindow({ tail: rows + OVERSCAN });
    else if (now.kind === "jump")
      onWindow({ start: Math.max(0, first - OVERSCAN), end: last + OVERSCAN });
    else
      onWindow({
        around: now.kind === "seek" ? now.key : now.asked,
        before: OVERSCAN,
        after: rows + OVERSCAN,
      });
  });
  useEffect(() => {
    ask();
  }, [follow, asked, rows, first, last, onWindow]);

  // After every change of the layout, the list places its lines: following,
  // at the end; paused, the line it holds at its offset, the line it seeks
  // once it is loaded or the answer says where it would stand. A scroll of
  // the person's whose event has not come yet moves the place with it.
  const arrange = (scroller: HTMLElement, shown: boolean) => {
    // The rows this commit measured moved the lines below them, which the
    // sizer shows only once it renders again: asking for the total rebuilds
    // the starts `startOf` reads, and says how far the list scrolls.
    const measured = virtualizer.getTotalSize();
    const max = Math.max(0, maxOf(scroller) + measured - size);
    // A step pauses as it reveals: a token that comes while following is
    // not a step's.
    const fresh = reveal !== undefined && reveal.token !== revealed.current;
    if (fresh) revealed.current = reveal.token;
    const revealing = fresh && !follow;
    if (revealing) {
      enter({ kind: "seek", key: reveal.key, offset: "centre" });
      onPlace?.({
        key: reveal.key,
        offset: -Math.round((scroller.clientHeight - ROW) / 2),
      });
    }
    if (follow !== followed.current) {
      followed.current = follow;
      if (follow) enter(FOLLOW);
    }
    const from = known.current;
    const moved = shown || revealing ? 0 : unseen(scroller);
    const now = mode.current;
    if (now.kind === "hold") {
      const index = placed(now.key);
      if (index !== undefined) {
        const begin = startOf(index);
        const at = begin + now.offset;
        // What the end cuts short is where the list now stands.
        const top = Math.min(Math.max(0, at + moved), max);
        write(scroller, top);
        if (moved !== 0) personal(scroller, at);
        else if (top !== at) hold(now.key, top - begin, now.asked);
      } else if (moved !== 0) personal(scroller, from);
      else if (around?.key === now.asked && now.asked !== now.key)
        enter({ ...now, asked: now.key });
      return;
    }
    if (moved !== 0) {
      personal(scroller, from);
      return;
    }
    if (now.kind === "follow") {
      if (follow || shown) write(scroller, max);
      if (!follow) {
        const top = topLine(scroller);
        if (top) hold(top.key, top.offset, top.key);
        else enter(JUMP);
      }
      return;
    }
    if (now.kind === "jump") {
      if (shown) write(scroller, from);
      const top = topLine(scroller);
      if (top) hold(top.key, top.offset, top.key);
      return;
    }
    const index = placed(now.key);
    if (index === undefined) return;
    const begin = startOf(index);
    const offset =
      now.offset === "centre"
        ? -(
            scroller.clientHeight -
            (virtualizer.measurementsCache[index]?.size ?? ROW)
          ) / 2
        : now.offset;
    const at = Math.min(Math.max(0, begin + offset), max);
    write(scroller, at);
    hold(now.key, at - begin, now.key);
  };
  const settle = useEffectEvent(() => {
    if (!element) return;
    if (element.clientHeight === 0) {
      hidden.current = true;
      return;
    }
    arrange(element, hidden.current);
    hidden.current = false;
  });
  useLayoutEffect(() => {
    settle();
  });

  useEffect(() => {
    virtualizer.measure();
  }, [wrap, virtualizer]);

  // Sizes are kept by line, so following with wrap would keep one for every
  // line that passed. Only those of lines no longer loaded go: a mounted row
  // is measured again only when its size changes, so one that lost its size
  // would stand at the estimate's height.
  useEffect(() => {
    const sizes = virtualizer.itemSizeCache;
    if (!follow || !wrap || sizes.size <= 4 * (rows + OVERSCAN)) return;
    const loaded = new Set(items.map((item) => item.key));
    for (const key of sizes.keys()) {
      if (typeof key !== "string" || !loaded.has(key)) sizes.delete(key);
    }
  }, [follow, wrap, items, rows, virtualizer]);

  const keyed = useEffectEvent((to: Move | number) => {
    if (!element) return;
    if (typeof to === "number") go(element, element.scrollTop + to * ROW);
    else move(element, to);
  });
  useEffect(() => {
    if (!element || !register) return;
    return register(element, {
      move: (delta) => {
        keyed(delta);
      },
      moveToEdge: (edge) => {
        keyed(edge);
      },
      activate: () => undefined,
    });
  }, [element, register]);

  return (
    <div className={cn("relative min-h-0", className)}>
      <div
        ref={setElement}
        role="log"
        aria-label={label}
        tabIndex={0}
        onScroll={() => {
          if (!element || hidden.current || element.clientHeight === 0) return;
          const from = known.current;
          if (unseen(element) !== 0) personal(element, from);
        }}
        // The person's wheel pauses at once, or follows again once it
        // reaches the end: the browser scrolls it against the end it last
        // drew, which lines that came since have moved. It counts from
        // where the list last stood, since Chromium may have scrolled by
        // the wheel before it dispatches it.
        onWheel={(event) => {
          if (follow) {
            if (event.deltaY < 0) onFollowChange(false);
          } else if (
            event.deltaY > 0 &&
            maxOf(event.currentTarget) - known.current - event.deltaY < ROW
          )
            onFollowChange(true);
        }}
        onKeyDown={(event) => {
          const to = moveOf(event);
          if (!to) return;
          event.preventDefault();
          move(event.currentTarget, to);
        }}
        className="h-full overflow-auto py-1 font-mono text-xs leading-[19px] outline-none [overflow-anchor:none] focus-visible:shadow-[inset_var(--focus-ring)]"
      >
        <div
          className={cn("relative", !wrap && "w-max min-w-full")}
          style={{ height: size }}
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
