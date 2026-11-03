import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/** A framed part of a section that stands on its own: a container. */
export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid gap-2 rounded-md px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--border)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
