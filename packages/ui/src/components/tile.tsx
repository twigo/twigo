import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/** The colours a person may give a context (ARCHITECTURE 4.2). */
export type TileColor =
  "red" | "orange" | "yellow" | "green" | "blue" | "purple";

const TINT: Readonly<Record<TileColor, string>> = {
  red: "bg-context-red/20",
  orange: "bg-context-orange/20",
  yellow: "bg-context-yellow/20",
  green: "bg-context-green/20",
  blue: "bg-context-blue/20",
  purple: "bg-context-purple/20",
};

/**
 * Two letters on the tint of a colour, as the rail draws a space and the
 * pickers draw a space or a context; without a colour, quieter on the card.
 * What it holds, such as a status dot, sits over it.
 */
export function Tile({
  letters,
  color,
  size = "md",
  className,
  children,
}: {
  letters: string;
  color: TileColor | undefined;
  /** `sm` in a row, `md` on the rail. */
  size?: "sm" | "md";
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center font-medium",
        size === "md"
          ? "size-8 rounded-md text-[11px]"
          : "size-5 rounded text-[9px]",
        color
          ? `${TINT[color]} text-foreground`
          : "bg-card text-muted-foreground",
        className,
      )}
    >
      {letters}
      {children}
    </span>
  );
}
