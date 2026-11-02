import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/** Text that opens something, in the brand's colour: a link to another object. */
export function LinkButton({
  onClick,
  title,
  className,
  children,
}: {
  onClick: () => void;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "rounded-sm text-left text-brand outline-none hover:underline focus-visible:shadow-[var(--focus-ring)]",
        className,
      )}
    >
      {children}
    </button>
  );
}
