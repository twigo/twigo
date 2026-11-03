import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/** A small quiet label: a Kubernetes label, a tag. */
export function Chip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-baseline rounded bg-muted px-1.5 py-px text-xs break-all",
        className,
      )}
    >
      {children}
    </span>
  );
}
