import { Skeleton } from "@twigo/ui";

// Loading placeholder shaped like a sidebar tree row (icon · name · meta), so a
// bucket/stream/object list load reads as "almost here" instead of a spinner.
const WIDTHS = ["58%", "74%", "46%", "67%", "52%", "70%", "60%"];

export function TreeSkeleton({ rows = 7 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-0.5 px-2 py-1" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-2 py-1">
          <Skeleton className="size-3.5 shrink-0 rounded-sm" />
          <Skeleton
            className="h-3"
            style={{ width: WIDTHS[i % WIDTHS.length] }}
          />
          <Skeleton className="ml-auto h-2.5 w-10 shrink-0" />
        </div>
      ))}
    </div>
  );
}
