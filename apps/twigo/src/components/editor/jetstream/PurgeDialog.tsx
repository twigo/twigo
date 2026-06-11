import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  Button,
} from "@twigo/ui";
import { fmtCount, fmtBytes } from "@twigo/utils";

// Purge with a computed blast-radius preview (count + bytes) — what you're
// about to lose, before you lose it.
export function PurgeDialog({
  open,
  onOpenChange,
  stream,
  messages,
  bytes,
  onPurge,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stream: string;
  messages: number;
  bytes: number;
  onPurge: (keep: number | null) => void;
}) {
  const [mode, setMode] = useState<"all" | "keep">("all");
  const [keep, setKeep] = useState("100");

  const submit = () => {
    if (mode === "all") {
      onPurge(null);
    } else {
      const n = Math.floor(Number(keep));
      if (Number.isFinite(n) && n >= 0) onPurge(n);
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-4">
        <DialogTitle className="text-sm font-semibold">
          Purge {stream}
        </DialogTitle>
        <DialogDescription className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          Purging permanently deletes messages from this stream. This can&apos;t
          be undone.
        </DialogDescription>

        <div className="mt-3 space-y-2 text-xs">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="purge-mode"
              checked={mode === "all"}
              onChange={() => setMode("all")}
            />
            <span>
              Delete all — ~{fmtCount(messages)} messages · {fmtBytes(bytes)}
            </span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="purge-mode"
              checked={mode === "keep"}
              onChange={() => setMode("keep")}
            />
            <span>Keep last</span>
            <input
              value={keep}
              onChange={(e) => setKeep(e.target.value)}
              onFocus={() => setMode("keep")}
              inputMode="numeric"
              aria-label="Messages to keep"
              className="h-7 w-20 rounded border border-border bg-background px-1.5 font-mono"
            />
            <span>messages</span>
          </label>
          <p className="text-[10px] text-muted-foreground">
            Counts are from the last refresh.
          </p>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={submit}>
            Purge
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
