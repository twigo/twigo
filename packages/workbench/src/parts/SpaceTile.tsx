import type { ReactNode } from "react";
import type { Space } from "@twigo/protocol";
import { Tile } from "@twigo/ui";
import { useChanges, useWorkbench } from "../react";
import { initials } from "./spaceBadge";

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
  return (
    <Tile
      letters={initials(space.name)}
      color={colors.ofSpace(space)}
      className={className}
    >
      {children}
    </Tile>
  );
}
