import { cn } from "@twigo/ui";
import { fmtTime, fmtBytes, type StreamMessage } from "@twigo/utils";

export function MessageTable({
  items,
  selectedId,
  onSelect,
}: {
  items: StreamMessage[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  return (
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
            onClick={() => onSelect(m.id)}
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
  );
}
