import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
  CodeViewer,
  cn,
} from "@twigo/ui";
import { parseRawConfig, diffRawConfig, type RawChange } from "./rawConfig";

export function RawConfigDialog({
  stream,
  config,
  onClose,
  onApply,
}: {
  stream: string;
  config: Record<string, unknown>;
  onClose: () => void;
  onApply: (config: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState(JSON.stringify(config, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<{
    changes: RawChange[];
    parsed: Record<string, unknown>;
  } | null>(null);

  const toReview = () => {
    const parsed = parseRawConfig(text, stream);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const changes = diffRawConfig(config, parsed.config);
    if (changes.length === 0) {
      setError("No changes.");
      return;
    }
    setError(null);
    setReview({ changes, parsed: parsed.config });
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="flex max-h-[80vh] w-[44rem] max-w-[90vw] flex-col p-5">
        <DialogTitle className="text-sm font-semibold">
          {stream} · raw config
        </DialogTitle>
        <DialogDescription className="mt-1 text-xs text-muted-foreground">
          Replaces the full stream config. Optional keys you remove reset to
          their defaults; required keys must stay.
        </DialogDescription>

        {review ? (
          <div className="mt-3 min-h-0 flex-1 overflow-auto rounded-md border border-border font-mono text-xs">
            {review.changes.map((c) => (
              <div
                key={c.key}
                className="flex items-baseline gap-2 border-b border-border px-2.5 py-1.5 last:border-b-0"
              >
                <span
                  className={cn(
                    "w-12 shrink-0 text-[10px] uppercase",
                    c.kind === "removed"
                      ? "text-error"
                      : "text-muted-foreground",
                  )}
                >
                  {c.kind}
                </span>
                <span className="w-36 shrink-0 text-muted-foreground">
                  {c.key}
                </span>
                {c.from !== undefined && (
                  <span className="break-all line-through opacity-60">
                    {c.from}
                  </span>
                )}
                {c.from !== undefined && c.to !== undefined && (
                  <span aria-hidden>→</span>
                )}
                {c.to !== undefined && (
                  <span className="break-all">{c.to}</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-3 min-h-64 flex-1">
            <CodeViewer
              value={text}
              language="json"
              onChange={(v) => {
                setText(v);
                setError(null);
              }}
              className="h-full"
            />
          </div>
        )}

        {error && <p className="mt-2 text-xs text-error">{error}</p>}

        <DialogFooter>
          {review ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setReview(null)}>
                Back
              </Button>
              <Button
                variant="brand"
                size="sm"
                onClick={() => {
                  onApply(review.parsed);
                  onClose();
                }}
              >
                Apply
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="brand" size="sm" onClick={toReview}>
                Review changes
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
