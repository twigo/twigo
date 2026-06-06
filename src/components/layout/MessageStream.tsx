import { Pause, Trash2, ArrowDownToLine, Send } from "lucide-react";
import { Button } from "@/components/ui/button";

const mockMessages = [
  { t: "12:04:31.221", subject: "orders.created", size: "312 B", preview: '{"id":"o_8421","total":59.9}' },
  { t: "12:04:31.198", subject: "orders.created", size: "287 B", preview: '{"id":"o_8420","total":12.0}' },
  { t: "12:04:30.944", subject: "orders.failed", size: "164 B", preview: '{"id":"o_8419","err":"card"}' },
  { t: "12:04:30.770", subject: "orders.created", size: "301 B", preview: '{"id":"o_8418","total":8.49}' },
  { t: "12:04:30.512", subject: "orders.created", size: "298 B", preview: '{"id":"o_8417","total":42.0}' },
];

export function MessageStream() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <Button variant="ghost" size="icon-sm" title="Pause">
          <Pause />
        </Button>
        <Button variant="ghost" size="icon-sm" title="Clear">
          <Trash2 />
        </Button>
        <Button variant="ghost" size="icon-sm" title="Scroll to latest">
          <ArrowDownToLine />
        </Button>
        <div className="ml-auto" />
        <Button variant="brand" size="sm">
          <Send />
          Publish
        </Button>
      </div>

      {/* table */}
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
            {mockMessages.map((m, i) => (
              <tr
                key={i}
                className="cursor-default border-b border-border/50 hover:bg-accent/50"
              >
                <td className="px-2 py-1 tabular-nums text-muted-foreground">{m.t}</td>
                <td className="px-2 py-1 text-brand">{m.subject}</td>
                <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                  {m.size}
                </td>
                <td className="truncate px-2 py-1">{m.preview}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
