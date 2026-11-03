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
      /** Where the line stood when the list last placed it. */
      readonly index: number;
      readonly offset: number;
      readonly asked: string;
    }
  | { readonly kind: "jump" };

const FOLLOW: Mode = { kind: "follow" };
const JUMP: Mode = { kind: "jump" };

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

/** How long after the person's wheel, scroll key or touch a scroll is still theirs. */
const INPUT_MS = 300;
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

/**
 * Whether the person scrolls the list, from their input: a wheel, a scroll
 * key or a touch that just ended, or a pointer or a touch that holds it,
 * its scrollbar included. The list's own scrolls and the virtualizer's are
 * never theirs.
 */
class Input {
  #until = 0;
  #held = { pointer: false, touch: false };

  get scrolling(): boolean {
    return (
      this.#held.pointer || this.#held.touch || performance.now() < this.#until
    );
  }

  touched(): void {
    this.#until = performance.now() + INPUT_MS;
  }

  hold(by: "pointer" | "touch"): void {
    this.#held[by] = true;
  }

  release(by: "pointer" | "touch"): void {
    if (!this.#held[by]) return;
    this.#held[by] = false;
    this.touched();
  }
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
   * A line to scroll to, such as the current search match, each time its
   * token changes, after the one it mounts with; one not loaded is asked
   * for around its key first.
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
  const [input] = useState(() => new Input());
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

  const enter = (next: Mode) => {
    mode.current = next;
    setAsked(askedBy(next));
  };
  const hold = (key: string, index: number, offset: number, ask: string) => {
    enter({ kind: "hold", key, index, offset, asked: ask });
    onPlace?.({ key, offset });
  };
  const indexOf = (key: string) => {
    const found = items.findIndex((item) => item.key === key);
    return found < 0 ? undefined : start + found;
  };
  // Placed by its own start: with wrap, the line that held its old index
  // is another height.
  const offsetOf = (index: number) =>
    virtualizer.measurementsCache[index]?.start ?? index * ROW;
  const topLine = () => {
    if (!element) return undefined;
    const top = virtualizer.getVirtualItemForOffset(element.scrollTop);
    const item = top && items[top.index - start];
    return item
      ? {
          key: item.key,
          index: top.index,
          offset: element.scrollTop - top.start,
        }
      : undefined;
  };

  // A tab the panel hid comes back at the top without a scroll event.
  const shownAgain = useEffectEvent(() => {
    const now = mode.current;
    if (now.kind === "follow") virtualizer.scrollToEnd();
    else if (now.kind === "hold")
      virtualizer.scrollToOffset(offsetOf(now.index) + now.offset);
    else if (now.kind === "jump")
      virtualizer.scrollToOffset(virtualizer.scrollOffset ?? 0);
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
    if (!element) return;
    const pointer = () => {
      input.release("pointer");
    };
    const touch = () => {
      input.release("touch");
    };
    const document = element.ownerDocument;
    document.addEventListener("pointerup", pointer);
    document.addEventListener("pointercancel", pointer);
    document.addEventListener("touchend", touch);
    document.addEventListener("touchcancel", touch);
    return () => {
      document.removeEventListener("pointerup", pointer);
      document.removeEventListener("pointercancel", pointer);
      document.removeEventListener("touchend", touch);
      document.removeEventListener("touchcancel", touch);
    };
  }, [element, input]);

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

  // Following, the end stays in view; paused, the list goes to the line it
  // seeks once it is loaded or the answer says where it would stand, and
  // keeps the line it holds put as lines enter and leave before it.
  const settle = useEffectEvent(() => {
    if (!element) return;
    if (reveal && reveal.token !== revealed.current) {
      revealed.current = reveal.token;
      enter({ kind: "seek", key: reveal.key, offset: "centre" });
      onPlace?.({
        key: reveal.key,
        offset: -Math.round((element.clientHeight - ROW) / 2),
      });
    }
    if (follow) {
      if (mode.current.kind !== "follow") enter(FOLLOW);
      if (total > 0) virtualizer.scrollToEnd();
      return;
    }
    const now = mode.current;
    if (now.kind === "follow" || now.kind === "jump") {
      const top = topLine();
      if (top) hold(top.key, top.index, top.offset, top.key);
      else if (now.kind === "follow") enter(JUMP);
      return;
    }
    const index =
      indexOf(now.key) ?? (around?.key === now.key ? around.index : undefined);
    if (now.kind === "seek") {
      if (index === undefined) return;
      const at =
        now.offset === "centre"
          ? (virtualizer.getOffsetForIndex(index, "center")?.[0] ??
            offsetOf(index))
          : offsetOf(index) + now.offset;
      virtualizer.scrollToOffset(at);
      hold(now.key, index, at - offsetOf(index), now.key);
      return;
    }
    if (index === undefined) {
      if (around?.key === now.asked && now.asked !== now.key)
        enter({ ...now, asked: now.key });
      return;
    }
    if (index === now.index) return;
    virtualizer.scrollToOffset(offsetOf(index) + now.offset);
    enter({ ...now, index });
  });
  useLayoutEffect(() => {
    settle();
  }, [
    element,
    follow,
    reveal,
    items,
    start,
    total,
    around?.key,
    around?.index,
  ]);

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

  useEffect(() => {
    if (!element || !register) return;
    return register(element, {
      move: (delta) => {
        input.touched();
        if (delta < 0) onFollowChange(false);
        virtualizer.scrollBy(delta * ROW);
      },
      moveToEdge: (edge) => {
        if (edge === "last") {
          onFollowChange(true);
          return;
        }
        input.touched();
        onFollowChange(false);
        virtualizer.scrollToOffset(0);
      },
      activate: () => undefined,
    });
  }, [element, input, register, onFollowChange, virtualizer]);

  const onScroll = () => {
    if (!element) return;
    const person = input.scrolling;
    const atEnd =
      element.scrollHeight - element.scrollTop - element.clientHeight < ROW;
    if (follow) {
      if (person && !atEnd) onFollowChange(false);
      return;
    }
    if (person && atEnd) {
      onFollowChange(true);
      return;
    }
    const now = mode.current;
    if (now.kind === "seek" && !person) return;
    const top = topLine();
    if (!top) {
      if (person) enter(JUMP);
      return;
    }
    let ask = top.key;
    if (now.kind === "hold") {
      const from = indexOf(now.asked);
      if (from !== undefined && Math.abs(from - top.index) <= DRIFT)
        ask = now.asked;
    }
    hold(top.key, top.index, top.offset, ask);
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
          input.touched();
          if (follow && event.deltaY < 0) onFollowChange(false);
        }}
        onKeyDown={(event) => {
          if (SCROLL_KEYS.has(event.key)) input.touched();
        }}
        onPointerDown={() => {
          input.hold("pointer");
        }}
        onTouchStart={() => {
          input.hold("touch");
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
