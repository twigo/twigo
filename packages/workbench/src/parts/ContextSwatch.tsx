import type { ContextColor } from "@twigo/protocol";
import { cn } from "@twigo/ui";

const FILL: Readonly<Record<ContextColor, string>> = {
  red: "bg-context-red",
  orange: "bg-context-orange",
  yellow: "bg-context-yellow",
  green: "bg-context-green",
  blue: "bg-context-blue",
  purple: "bg-context-purple",
};

/** A context's colour as a round swatch, for the colour picker. */
export function ContextSwatch({
  color,
  className,
}: {
  color: ContextColor;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-3 shrink-0 rounded-full",
        FILL[color],
        className,
      )}
    />
  );
}
