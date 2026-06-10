import { useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@twigo/ui";
import { useConnections } from "@/store/connections";
import { StatusGlyph } from "./StatusGlyph";
import { ConnectionPicker } from "./ConnectionPicker";

export function ConnectionSwitcher() {
  const [open, setOpen] = useState(false);
  const activeContext = useConnections((s) => s.activeContext);
  const info = useConnections((s) =>
    activeContext ? s.connected[activeContext] : undefined,
  );
  const connecting = useConnections((s) =>
    activeContext ? !!s.connecting[activeContext] : false,
  );
  const error = useConnections((s) =>
    activeContext ? !!s.connError[activeContext] : false,
  );
  const liveCount = useConnections(
    (s) => Object.values(s.connected).filter((i) => i.connected).length,
  );

  return (
    <div className="px-2 pb-1 pt-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Switch connection"
            className="flex h-8 w-full items-center gap-2 rounded-md border border-input bg-background px-2 text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {activeContext ? (
              <>
                <StatusGlyph
                  info={info}
                  connecting={connecting}
                  error={error}
                />
                <span className="min-w-0 flex-1 truncate text-left font-medium">
                  {activeContext}
                </span>
              </>
            ) : (
              <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">
                Select connection…
              </span>
            )}
            {liveCount > 0 && (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {liveCount} live
              </span>
            )}
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0"
        >
          <ConnectionPicker onClose={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    </div>
  );
}
