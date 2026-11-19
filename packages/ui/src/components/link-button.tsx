import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/** Text that opens something, in the brand's colour: a link to another object. */
export function LinkButton({
  onClick,
  title,
  label,
  className,
  children,
}: {
  onClick: () => void;
  title?: string;
  /** Its accessible name, where its text is in parts that a screen reader would run together. */
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={label}
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
