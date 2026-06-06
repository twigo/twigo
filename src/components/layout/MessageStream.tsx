import { Pause, Play, Trash2 } from "lucide-react";
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

  if (!subject) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select a subject to stream messages.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
        <div className="min-h-0 flex-1 overflow-auto">
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
              {items
                .slice()
                .reverse()
                .map((m) => (
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
    </div>
  );
}
