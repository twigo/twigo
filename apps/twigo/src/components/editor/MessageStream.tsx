import { useLayoutEffect, useRef, useState } from "react";
import { Allotment } from "allotment";
import { Pause, Play, Trash2, ArrowDown, Radio, Search } from "lucide-react";
import { Button, EmptyState } from "@twigo/ui";
import { fmtCount } from "@twigo/utils";
import { useStream } from "@/store/stream";
import { useUi } from "@/store/ui";
import { messageMatches } from "@/lib/messageFilter";
import { MessageTable } from "./MessageTable";
import { DetailPanel } from "./DetailPanel";

export function computeUnread(
  atBottom: boolean,
  filterActive: boolean,
  filteredItems: { id: number }[],
  allLastId: number,
  lastSeenId: number,
): number {
  if (atBottom) return 0;
  // With a filter on, ids are non-contiguous, so a delta would also count the
  // hidden messages; count only the filtered rows newer than what was seen.
  if (filterActive)
    return filteredItems.filter((m) => m.id > lastSeenId).length;
  return Math.max(0, allLastId - lastSeenId);
}

export function MessageStream({ streamId }: { streamId: string }) {
  const session = useStream((s) => s.sessions[streamId]);
  const detailOpen = useUi((s) => s.detailOpen);
  const togglePause = useStream((s) => s.togglePause);
  const clear = useStream((s) => s.clear);
  const setFollowing = useStream((s) => s.setFollowing);
  const select = useStream((s) => s.select);
  // The ref serves imperative scrolling; the state copy re-renders the
  // virtualizer once the element exists (a bare ref would still be null when
  // MessageTable's layout effect mounts it).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const attachScroll = (el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
  };
  const [atBottom, setAtBottom] = useState(true);
  const [lastSeenId, setLastSeenId] = useState(0);
  const [filter, setFilter] = useState("");

  const allItems = session?.items ?? [];
  const f = filter.trim().toLowerCase();
  // Filter the displayed rows by subject or payload preview (display-only; the
  // ring buffer and follow logic still run on the full stream).
  const items = f
    ? allItems.filter((m) => messageMatches(m.subject, m.preview, filter))
    : allItems;
  // Track the tail against the full stream so lastSeenId and the unread count
  // live in the same id space whether or not a filter is active.
  const lastId =
    (allItems.length ? allItems[allItems.length - 1] : undefined)?.id ?? 0;
  const unread = computeUnread(
    atBottom,
    f.length > 0,
    items,
    lastId,
    lastSeenId,
  );

  // Follow the tail while pinned to the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [scrollEl, lastId, atBottom]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAtBottom(bottom);
    setFollowing(streamId, bottom);
    if (bottom) setLastSeenId(lastId);
  }

  function jumpToLatest() {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
    setAtBottom(true);
    setFollowing(streamId, true);
    setLastSeenId(lastId);
  }

  function handleClear() {
    clear(streamId);
    setAtBottom(true);
    setLastSeenId(0);
  }

  if (!session) {
    return (
      <EmptyState className="h-full">
        Select a subject to stream messages.
      </EmptyState>
    );
  }

  const { subject, paused, selectedId, received, dropped } = session;
  // The view keeps a capped window; show the true received total (and the
  // retained slice when it's smaller) so the user knows they're tailing.
  const windowed = allItems.length > 0 && allItems.length < received;

  // The inspector is a right split inside this tab, shown only when a message is
  // selected and the user hasn't collapsed it (mod+alt+b) - so the table keeps
  // full width otherwise, and no inspector exists on non-stream tabs.
  const inspectorVisible = detailOpen && selectedId !== null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={paused ? "Resume" : "Pause"}
          title={paused ? "Resume" : "Pause"}
          onClick={() => togglePause(streamId)}
        >
          {paused ? <Play /> : <Pause />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Clear"
          title="Clear"
          onClick={handleClear}
        >
          <Trash2 />
        </Button>
        <span className="ml-1 flex min-w-0 flex-1 items-center gap-1 text-[11px] text-brand">
          <Radio className="size-3 shrink-0" />
          <span className="truncate font-mono">{subject}</span>
        </span>
        <div className="flex items-center gap-1 rounded border border-input bg-background px-1.5 py-0.5">
          <Search className="size-3 shrink-0 text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter messages"
            placeholder="Filter…"
            className="w-24 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
          />
        </div>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {f
            ? `${items.length} of ${fmtCount(allItems.length)}`
            : `${fmtCount(received)} msgs${
                windowed ? ` · last ${fmtCount(allItems.length)}` : ""
              }`}
          {paused && " · paused"}
        </span>
        {dropped > 0 && (
          <span
            className="text-[11px] tabular-nums text-warn"
            title="Messages dropped under load to keep the UI responsive"
          >
            · {fmtCount(dropped)} dropped
          </span>
        )}
      </div>

      {allItems.length === 0 ? (
        <EmptyState className="min-h-0 flex-1">
          <span>
            Waiting for messages on <span className="font-mono">{subject}</span>
            …
          </span>
        </EmptyState>
      ) : items.length === 0 ? (
        <EmptyState className="min-h-0 flex-1">
          No messages match “{filter.trim()}”.
        </EmptyState>
      ) : (
        <Allotment className="min-h-0 flex-1" proportionalLayout={false}>
          <Allotment.Pane minSize={320}>
            <div className="relative h-full">
              <div
                ref={attachScroll}
                onScroll={onScroll}
                className="h-full overflow-auto"
              >
                <MessageTable
                  items={items}
                  selectedId={selectedId}
                  scrollEl={scrollEl}
                  onSelect={(id) => {
                    select(streamId, id);
                  }}
                />
              </div>
              {!atBottom && (
                <button
                  type="button"
                  onClick={jumpToLatest}
                  aria-label={
                    unread > 0
                      ? `Jump to ${unread.toString()} new messages`
                      : "Jump to latest"
                  }
                  className="absolute bottom-4 right-4 flex size-9 items-center justify-center rounded-full border border-border bg-popover text-foreground shadow-lg transition-colors duration-150 animate-in fade-in zoom-in-90 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ArrowDown className="size-4" />
                  {unread > 0 && (
                    <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold tabular-nums text-brand-foreground">
                      {unread > 99 ? "99+" : unread}
                    </span>
                  )}
                </button>
              )}
            </div>
          </Allotment.Pane>
          <Allotment.Pane
            visible={inspectorVisible}
            preferredSize={380}
            minSize={260}
          >
            <DetailPanel streamId={streamId} />
          </Allotment.Pane>
        </Allotment>
      )}
    </div>
  );
}
