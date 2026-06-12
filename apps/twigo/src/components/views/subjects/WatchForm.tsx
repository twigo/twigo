import { useState } from "react";
import { Play } from "lucide-react";
import { Button } from "@twigo/ui";

// Core NATS has no subject registry, so the user picks a pattern to discover
// subjects from live traffic. Decoupled from the store via onStart.
export function WatchForm({ onStart }: { onStart: (pattern: string) => void }) {
  const [pattern, setPattern] = useState(">");
  return (
    <div className="space-y-2 px-2 py-2">
      <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
        Core NATS has no subject registry. Subscribe to a pattern to discover
        subjects from live traffic - this receives matching messages while
        running.
      </p>
      <div className="flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1">
        <span className="font-mono text-[11px] text-muted-foreground">
          pattern
        </span>
        <input
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          aria-label="Subject pattern to watch"
          spellCheck={false}
          className="w-full bg-transparent font-mono text-xs outline-none"
        />
      </div>
      <Button
        variant="brand"
        size="sm"
        className="w-full"
        onClick={() => onStart(pattern)}
      >
        <Play />
        Start listening
      </Button>
    </div>
  );
}
