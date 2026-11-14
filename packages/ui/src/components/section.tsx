import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../lib/cn";

const SIZES = {
  sm: {
    header: "h-[26px] pr-1",
    title: "px-2 text-2xs text-support hover:text-content",
    chevron: "size-3.5",
  },
  md: {
    header: "h-6 border-b border-border-subtle",
    title: "text-body text-strong",
    chevron: "size-3 text-support group-hover/title:text-content",
  },
  group: {
    header: "h-5",
    title: "text-xs text-support",
    chevron: "size-3 group-hover/title:text-content",
  },
} as const;

/**
 * A titled part of a view that folds: Overview's sections, the views of a
 * side bar. In an editor its title is strong over a hairline, and a hover
 * shows on its chevron, which follows the title; in a side bar the chevron
 * leads. The header holds the section's actions at its end.
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
  /**
   * `sm` for a side bar's views, `md` for an editor's sections, `group` for
   * a fold inside a section, as quiet as the groups there that do not fold.
   */
  size?: keyof typeof SIZES;
  className?: string;
  children: ReactNode;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  const { header, title: titleClass, chevron } = SIZES[size];
  return (
    <section
      aria-label={title}
      className={cn("flex flex-col", size !== "sm" && "gap-2", className)}
    >
      <div className={cn("flex shrink-0 items-center gap-1", header)}>
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className={cn(
            "group/title flex h-full min-w-0 flex-1 items-center gap-1 text-left font-semibold outline-none focus-visible:shadow-[var(--focus-ring)]",
            titleClass,
          )}
        >
          {size === "sm" && (
            <Chevron aria-hidden className={cn("shrink-0", chevron)} />
          )}
          <span className="truncate">{title}</span>
          {size !== "sm" && (
            <Chevron aria-hidden className={cn("shrink-0", chevron)} />
          )}
        </button>
        {actions}
      </div>
      {open && children}
    </section>
  );
}
