import { cn } from "../lib/cn";

export type ContextDotColor =
  "red" | "orange" | "yellow" | "green" | "blue" | "purple";

const FILL: Record<ContextDotColor, string> = {
  red: "bg-context-red",
  orange: "bg-context-orange",
  yellow: "bg-context-yellow",
  green: "bg-context-green",
  blue: "bg-context-blue",
  purple: "bg-context-purple",
};

/** The colour a user gave a context, shown before its name (ARCHITECTURE 4.2). */
export function ContextDot({
  color,
  className,
}: {
  color: ContextDotColor;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-color={color}
      className={cn("size-2 shrink-0 rounded-full", FILL[color], className)}
    />
  );
}
