import type { ReactNode } from "react";
import type { ContextColor, Space } from "@twigo/protocol";
import { cn } from "@twigo/ui";
import { useChanges, useWorkbench } from "../react";
import { initials } from "./spaceBadge";

/** The tint of a space's tile, from its one context's colour. */
const TINT: Readonly<Record<ContextColor, string>> = {
  red: "bg-context-red/20 text-foreground",
  orange: "bg-context-orange/20 text-foreground",
  yellow: "bg-context-yellow/20 text-foreground",
  green: "bg-context-green/20 text-foreground",
  blue: "bg-context-blue/20 text-foreground",
  purple: "bg-context-purple/20 text-foreground",
};

/**
 * A space's tile (ARCHITECTURE 4.2): two letters on the tint of its
 * context's colour, as the rail and the cluster's home show it.
 */
export function SpaceTile({
  space,
  className,
  children,
}: {
  space: Space;
  className?: string;
  /** Drawn over the tile, such as the rail's connection dot. */
  children?: ReactNode;
}) {
  const { colors } = useWorkbench();
  useChanges(colors.changes);
  const color = colors.ofSpace(space);
  return (
    <span
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center rounded-md text-[11px] font-medium",
        color ? TINT[color] : "bg-card text-muted-foreground",
        className,
      )}
    >
      {initials(space.name)}
      {children}
    </span>
  );
}
