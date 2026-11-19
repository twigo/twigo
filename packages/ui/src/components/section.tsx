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
    header: "sticky top-0 z-10 bg-editor px-3.5",
    bar: "h-6 border-b border-border-subtle",
    title: "text-body text-strong",
    chevron: "size-3 text-support group-hover/title:text-content",
  },
} as const;

/**
 * A titled part of a view that folds: Overview's sections, the views of a
 * side bar. The chevron leads, and in an editor the title is strong over a
 * hairline and a hover shows on the chevron; the summary at the header's end
 * is cut before the title is, and chevron, title and summary are one toggle. A section holding what is wrong marks its header with a 3 px edge
 * in its tone, as a problem row of a list is marked, and the header of the
 * section in view sticks to the top of the part that scrolls, over its own
 * content, which is isolated so that nothing in it, a list's sticky header
 * as well, paints over the header or takes its clicks. The header holds the
 * section's actions at its end.
 */
export function Section({
  title,
  open,
  onToggle,
  summary,
  tone,
  actions,
  size = "md",
  id,
  className,
  children,
}: {
  title: string;
  open: boolean;
  /** `all` while Alt is held, as the toggle of every section of the page. */
  onToggle: (all: boolean) => void;
  summary?: ReactNode;
  tone?: "error" | "warn" | undefined;
  actions?: ReactNode;
  /**
   * `sm` for a side bar's views, `md` for an editor's sections.
   */
  size?: keyof typeof SIZES;
  /** What finds the section in the page, such as the place a scroll keeps. */
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  const { header, title: titleClass, chevron } = SIZES[size];
  const bar = size === "md" ? SIZES.md.bar : undefined;
  const toggle = (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={(event) => {
          onToggle(event.altKey);
        }}
        className={cn(
          "group/title flex h-full min-w-0 flex-1 items-center gap-1 text-left font-semibold outline-none focus-visible:shadow-[var(--focus-ring)]",
          titleClass,
        )}
      >
        <Chevron aria-hidden className={cn("shrink-0", chevron)} />
        <span
          className={cn("truncate", size === "md" && "max-w-full shrink-0")}
        >
          {title}
        </span>
        {summary && (
          <span className="ml-auto min-w-0 truncate pl-2 text-xs font-normal text-support">
            {summary}
          </span>
        )}
      </button>
      {actions}
    </>
  );
  return (
    <section
      aria-label={title}
      data-section={id}
      className={cn("flex flex-col", size !== "sm" && "gap-2", className)}
    >
      <div
        data-tone={tone}
        className={cn(
          "shrink-0",
          tone && "shadow-[inset_3px_0_0_var(--edge)]",
          header,
          bar === undefined && "flex items-center gap-1",
        )}
      >
        {bar === undefined ? (
          toggle
        ) : (
          <div className={cn("flex items-center gap-1", bar)}>{toggle}</div>
        )}
      </div>
      {open &&
        (size === "md" ? (
          <div className="isolate px-3.5">{children}</div>
        ) : (
          children
        ))}
    </section>
  );
}
