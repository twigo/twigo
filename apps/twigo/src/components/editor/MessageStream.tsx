import { useLayoutEffect, useRef, useState } from "react";
import { Pause, Play, Trash2, ArrowDown, Radio } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtTime, fmtBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useStream } from "@/store/stream";

export function MessageStream({ streamId }: { streamId: string }) {
  const session = useStream((s) => s.sessions[streamId]);
  const togglePause = useStream((s) => s.togglePause);
  const clear = useStream((s) => s.clear);
  const setFollowing = useStream((s) => s.setFollowing);
  const select = useStream((s) => s.select);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [lastSeenId, setLastSeenId] = useState(0);

  const items = session?.items ?? [];
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

  const { subject, paused, selectedId } = session;

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
        <span className="ml-1 flex min-w-0 items-center gap-1 text-[11px] text-brand">
          <Radio className="size-3 shrink-0" />
          <span className="truncate font-mono">{subject}</span>
        </span>
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          {items.length} msgs{paused && " · paused"}
        </span>
      </div>

      {items.length === 0 ? (
        <EmptyState className="min-h-0 flex-1">
          <span>
            Waiting for messages on <span className="font-mono">{subject}</span>
            …
          </span>
        </EmptyState>
      ) : (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-auto"
        >
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-panel text-left text-muted-foreground">
              <tr className="[&>th]:px-2 [&>th]:py-1 [&>th]:font-medium">
                <th className="w-28">Time</th>
                <th className="w-44">Subject</th>
                <th className="w-16 text-right">Size</th>
                <th>Payload</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {items.map((m) => (
                <tr
                  key={m.id}
                  onClick={() => {
                    select(streamId, m.id);
                  }}
                  className={cn(
                    "cursor-pointer border-b border-border/50 hover:bg-accent/50",
                    m.id === selectedId && "bg-accent",
                  )}
                >
                  <td className="px-2 py-1 tabular-nums text-muted-foreground">
                    {fmtTime(m.receivedAt)}
                  </td>
                  <td className="px-2 py-1 text-brand">{m.subject}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                    {fmtBytes(m.size)}
                  </td>
                  <td className="max-w-0 truncate px-2 py-1">{m.preview}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
