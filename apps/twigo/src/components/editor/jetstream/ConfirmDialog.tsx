import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  Button,
} from "@twigo/ui";

// Confirmation for a destructive JetStream action. When `confirmWord` is set
// (e.g. a stream name), the user must type it to enable the action - the strong
// guard for irreversible operations.
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  confirmWord,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  confirmWord?: string;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const ready = !confirmWord || typed === confirmWord;

  const change = (next: boolean) => {
    if (!next) setTyped("");
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="p-4">
        <DialogTitle className="text-sm font-semibold">{title}</DialogTitle>
        <DialogDescription className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {description}
        </DialogDescription>

        {confirmWord && (
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            spellCheck={false}
            placeholder={`Type "${confirmWord}" to confirm`}
            aria-label="Type to confirm"
            className="mt-3 h-8 w-full rounded border border-border bg-background px-2 font-mono text-xs"
          />
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => change(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={!ready}
            onClick={() => {
              onConfirm();
              change(false);
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
