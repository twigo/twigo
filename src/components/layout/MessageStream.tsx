import { useLayoutEffect, useRef, useState } from "react";
import { Pause, Play, Trash2, ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStream } from "@/store/stream";

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, len = 2) => n.toString().padStart(len, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

export function MessageStream() {
  const { subject, items, paused, togglePause, clear } = useStream();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [lastSeenId, setLastSeenId] = useState(0);

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
    if (bottom) setLastSeenId(lastId);
  }

  function jumpToLatest() {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
    setAtBottom(true);
    setLastSeenId(lastId);
  }

  if (!subject) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select a subject to stream messages.
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={paused ? "Resume" : "Pause"}
          title={paused ? "Resume" : "Pause"}
          onClick={togglePause}
        >
          {paused ? <Play /> : <Pause />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Clear"
          title="Clear"
          onClick={clear}
        >
          <Trash2 />
        </Button>
        <span className="ml-1 text-[11px] tabular-nums text-muted-foreground">
          {items.length} msgs{paused && " · paused"}
        </span>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          Waiting for messages on{" "}
          <span className="ml-1 font-mono">{subject}</span>…
        </div>
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
                  className="cursor-default border-b border-border/50 hover:bg-accent/50"
                >
                  <td className="px-2 py-1 tabular-nums text-muted-foreground">
                    {fmtTime(m.receivedAt)}
                  </td>
                  <td className="px-2 py-1 text-brand">{m.subject}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                    {fmtSize(m.size)}
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
            unread > 0 ? `Jump to ${unread} new messages` : "Jump to latest"
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
