import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * One entry of a list of facts, such as the full page's index of sections: its
 * title and what it holds on one line, the summary cut before the title is,
 * and a tone as the edge at its left that a section's header has. Its hit box
 * is the whole width and its hover a rounded plate inside it.
 */
export function Entry({
  title,
  summary,
  tone,
  onClick,
}: {
  title: string;
  summary?: ReactNode;
  tone?: "error" | "warn" | undefined;
  onClick: () => void;
}) {
  return (
    <div
      data-tone={tone}
      className={cn("h-7", tone && "shadow-[inset_3px_0_0_var(--edge)]")}
    >
      <button
        type="button"
        onClick={onClick}
        className="relative isolate flex h-full w-full min-w-0 items-center gap-2 px-3.5 text-left outline-none before:absolute before:inset-x-1.5 before:inset-y-0 before:-z-10 before:rounded-md hover:before:bg-row-hover focus-visible:before:shadow-[var(--focus-ring)]"
      >
        <span className="max-w-full shrink-0 truncate text-body font-semibold text-content">
          {title}
        </span>
        {summary && (
          <span className="ml-auto min-w-0 truncate text-xs text-support">
            {summary}
          </span>
        )}
      </button>
    </div>
  );
}
