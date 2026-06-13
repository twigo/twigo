import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
  RadioGroup,
  RadioGroupItem,
} from "@twigo/ui";
import { fmtCount, fmtBytes } from "@twigo/utils";

// Purge with a computed blast-radius preview (count + bytes) - what you're
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
      <DialogContent className="p-5">
        <DialogTitle className="text-sm font-semibold">
          Purge {stream}
        </DialogTitle>
        <DialogDescription className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          Purging permanently deletes messages from this stream. This can&apos;t
          be undone.
        </DialogDescription>

        <RadioGroup
          value={mode}
          onValueChange={(v) => setMode(v as "all" | "keep")}
          className="mt-3 gap-2 text-xs"
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="all" id="purge-all" />
            <label htmlFor="purge-all">
              Delete all - ~{fmtCount(messages)} messages · {fmtBytes(bytes)}
            </label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="keep" id="purge-keep" />
            <label htmlFor="purge-keep">Keep last</label>
            <input
              value={keep}
              onChange={(e) => setKeep(e.target.value)}
              onFocus={() => setMode("keep")}
              inputMode="numeric"
              aria-label="Messages to keep"
              className="h-7 w-20 rounded border border-border bg-background px-1.5 font-mono"
            />
            <span>messages</span>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Counts are from the last refresh.
          </p>
        </RadioGroup>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={submit}>
            Purge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
