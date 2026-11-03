import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../lib/cn";

/**
 * A titled part of a view that folds: Overview's sections, the views of a
 * side bar. Its title is a quiet label; in an editor it lines up with the
 * content and its chevron follows it, in a side bar the chevron leads.
 * The header holds the section's actions at its end.
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
    <section
      aria-label={title}
      className={cn("flex flex-col", size === "md" && "gap-2", className)}
    >
      <div
        className={cn(
          "flex shrink-0 items-center gap-1",
          size === "sm" ? "h-[26px] pr-1" : "h-5",
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className={cn(
            "flex h-full min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-semibold text-muted-foreground outline-none hover:text-foreground focus-visible:shadow-[var(--focus-ring)]",
            size === "sm" && "px-2",
          )}
        >
          {size === "sm" && (
            <Chevron aria-hidden className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{title}</span>
          {size === "md" && <Chevron aria-hidden className="size-3 shrink-0" />}
        </button>
        {actions}
      </div>
      {open && children}
    </section>
  );
}
