import type { ReactNode } from "react";
import type { Space } from "@twigo/protocol";
import { SpaceTile } from "./SpaceTile";

/**
 * The 20 px tile that leads what can outlive its space or be left with the
 * person elsewhere, a toast among it, for `ui` to place as a slot; nothing
 * for what belongs to no space.
 */
export function spaceMark(space: Space | undefined): ReactNode {
  return space && <SpaceTile space={space} size="sm" />;
}
