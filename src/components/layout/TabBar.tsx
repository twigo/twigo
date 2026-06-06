import { X, Radio } from "lucide-react";
import { useStream } from "@/store/stream";

export function TabBar() {
  const { subject, close } = useStream();
  if (!subject)
    return <div className="h-9 shrink-0 border-b border-border bg-panel" />;

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-panel">
      <div className="group relative flex items-center gap-1.5 border-r border-border bg-background px-3 text-xs">
        <span className="absolute inset-x-0 top-0 h-0.5 bg-brand" />
        <Radio className="size-3.5 text-brand" />
        <span className="font-mono">{subject}</span>
        <button
          type="button"
          aria-label={`Close ${subject}`}
          onClick={() => void close()}
          className="ml-1 rounded p-0.5 hover:bg-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3" />
        </button>
      </div>
    </div>
  );
}
