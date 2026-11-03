import type { CSSProperties, ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * A hairline frame that clips what it holds: a grid inside a section. Its
 * border takes room of its own, so a sticky header or a row's background
 * does not paint over it.
 */
export function Frame({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-border",
        className,
      )}
      style={style}
    >
      {children}
    </div>
  );
}
