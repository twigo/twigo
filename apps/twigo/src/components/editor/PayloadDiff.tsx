import { cn } from "@twigo/ui";
import { diffPayload } from "@/lib/diff";

// Unified line diff of two payloads: removed lines from the pinned message,
// added lines from the current one.
export function PayloadDiff({ a, b }: { a: string; b: string }) {
  const lines = diffPayload(a, b);
  const changed = lines.some((l) => l.type !== "ctx");

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-background font-mono text-[11px] leading-relaxed">
      {!changed ? (
        <div className="px-2 py-1 text-muted-foreground">
          Payloads are identical.
        </div>
      ) : (
        lines.map((l, i) => (
          <div
            key={i}
            className={cn(
              "flex gap-1 px-2",
              l.type === "add" && "bg-ok/15",
              l.type === "del" && "bg-error/15",
            )}
          >
            <span
              className={cn(
                "w-2 shrink-0 select-none text-center",
                l.type === "add" && "text-ok",
                l.type === "del" && "text-error",
                l.type === "ctx" && "text-muted-foreground/40",
              )}
            >
              {l.type === "add" ? "+" : l.type === "del" ? "-" : ""}
            </span>
            <span
              className={cn(
                "whitespace-pre-wrap break-all",
                l.type === "ctx" && "text-muted-foreground",
              )}
            >
              {l.text || " "}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
