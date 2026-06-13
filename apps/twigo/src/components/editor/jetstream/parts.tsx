import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn, Skeleton } from "@twigo/ui";

// Loading shape for a detail panel: a couple of titled sections of key/value
// rows, mirroring the real Section/Row layout so a load reads as "almost here".
export function DetailSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-3">
      {[0, 1].map((s) => (
        <div key={s} className="space-y-1.5">
          <Skeleton className="h-2.5 w-20" />
          <div className="space-y-2.5 rounded-md border border-border px-3 py-2.5">
            {[0, 1, 2].map((r) => (
              <div key={r} className="flex items-center justify-between gap-4">
                <Skeleton className="h-2.5 w-16" />
                <Skeleton className="h-2.5 w-24" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Row({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 truncate text-right font-mono text-xs">
        {value}
      </span>
    </div>
  );
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <div className="rounded-md border border-border px-3 py-1">
        {children}
      </div>
    </section>
  );
}

export function RawJson({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={cn("size-3 transition-transform", open && "rotate-90")}
        />
        Raw JSON
      </button>
      {open && (
        <pre className="mt-1 max-h-80 overflow-auto rounded-md border border-border bg-panel p-2 font-mono text-[11px] leading-relaxed">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </section>
  );
}
