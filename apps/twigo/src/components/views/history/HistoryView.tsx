import { History, Send, ArrowLeftRight, Trash2 } from "lucide-react";
import { Button, EmptyState } from "@twigo/ui";
import { decodeText, fmtRelTime } from "@twigo/utils";
import { useHistory, type SentEntry } from "@/store/history";
import { openPublish } from "@/lib/editor";
import type { ViewProps } from "@/shell/views";

function replay(e: SentEntry) {
  openPublish(
    e.connId,
    e.subject,
    e.truncated ? "" : decodeText(e.payloadB64),
    e.headers,
  );
}

export function HistoryView({ filter, connId }: ViewProps) {
  const entries = useHistory((s) => s.entries);
  if (!connId) {
    return (
      <EmptyState density="inline">
        Connect to a server to see what you sent.
      </EmptyState>
    );
  }
  const needle = filter.trim().toLowerCase();
  const rows = entries.filter(
    (e) =>
      e.connId === connId &&
      (needle === "" || e.subject.toLowerCase().includes(needle)),
  );

  if (rows.length === 0) {
    return (
      <EmptyState density="inline" icon={History}>
        {entries.some((e) => e.connId === connId)
          ? `Nothing sent matches “${filter.trim()}”.`
          : "Everything you publish or request lands here, replayable."}
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-end px-1 pb-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => useHistory.getState().clear(connId)}
        >
          <Trash2 />
          Clear
        </Button>
      </div>
      <ul>
        {rows.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => replay(e)}
              title="Open in a publish tab"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {e.kind === "publish" ? (
                <Send className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ArrowLeftRight className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs">
                  {e.subject}
                </span>
                <span className="block text-[10px] text-muted-foreground">
                  {fmtRelTime(e.at)}
                  {e.truncated ? " · payload too large to keep" : ""}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
