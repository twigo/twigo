import { useLayoutEffect, useRef, useState } from "react";
import { Pause, Play, Trash2, ArrowDown, Radio, Search } from "lucide-react";
import { Button, EmptyState } from "@twigo/ui";
import { fmtCount } from "@twigo/utils";
import { useStream } from "@/store/stream";
import { messageMatches } from "@/lib/messageFilter";
import { MessageTable } from "./MessageTable";

export function MessageStream({ streamId }: { streamId: string }) {
  const session = useStream((s) => s.sessions[streamId]);
  const togglePause = useStream((s) => s.togglePause);
  const clear = useStream((s) => s.clear);
  const setFollowing = useStream((s) => s.setFollowing);
  const select = useStream((s) => s.select);
  const scrollRef = useRef<HTMLDivElement>(null);
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
  const lastId = (items.length ? items[items.length - 1] : undefined)?.id ?? 0;
  const unread = atBottom ? 0 : Math.max(0, lastId - lastSeenId);

  // Follow the tail while pinned to the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [lastId, atBottom]);

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

  const { subject, paused, selectedId, received } = session;
  // The view keeps a capped window; show the true received total (and the
  // retained slice when it's smaller) so the user knows they're tailing.
  const windowed = allItems.length > 0 && allItems.length < received;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
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
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-auto"
        >
          <MessageTable
            items={items}
            selectedId={selectedId}
            onSelect={(id) => {
              select(streamId, id);
            }}
          />
        </div>
      )}

      {!atBottom && items.length > 0 && (
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
  );
}
