import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import type { TextRange } from "../lib/match";

/**
 * A label with what matched a search drawn bold in the brand colour, as
 * VS Code's quick input draws it. The ranges come in order and apart.
 */
export function HighlightedLabel({
  text,
  ranges,
  className,
}: {
  text: string;
  ranges: readonly TextRange[];
  className?: string;
}) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const { start, end } of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={start} className="bg-transparent font-medium text-brand">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <span className={cn("truncate", className)}>{parts}</span>;
}
