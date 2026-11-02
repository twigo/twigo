import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../lib/cn";

/**
 * A titled part of a view that folds: Overview's sections, the views of a
 * side bar. The header holds the section's actions at its end.
 */
export function Section({
  title,
  open,
  onToggle,
  actions,
  size = "md",
  className,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  actions?: ReactNode;
  /** `sm` for a side bar's views, `md` for an editor's sections. */
  size?: "sm" | "md";
  className?: string;
  children: ReactNode;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section aria-label={title} className={cn("flex flex-col", className)}>
      <div
        className={cn(
          "flex shrink-0 items-center gap-1 pr-1",
          size === "sm" ? "h-6" : "h-8",
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className={cn(
            "flex h-full min-w-0 flex-1 items-center gap-1 px-2 text-left font-semibold outline-none focus-visible:shadow-[inset_var(--focus-ring)]",
            size === "sm" && "text-xs",
          )}
        >
          <Chevron
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="truncate">{title}</span>
        </button>
        {actions}
      </div>
      {open && children}
    </section>
  );
}
