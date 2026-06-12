import { cn } from "../lib/cn";

// A single shimmering placeholder bar. Compose these into the shape of the real
// content (rows/columns) so a load reads as "almost here", not "frozen".
export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={cn("animate-pulse rounded bg-muted", className)}
      style={style}
    />
  );
}
