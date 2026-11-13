import { useEffect } from "react";
import type { Gvr, ObjectSnapshot, Resource } from "@twigo/protocol";
import { servesUsage, type Loaded } from "../discovery";
import type { Expected } from "./Usage";
import type { UsageSaid } from "./usageSaid";

/**
 * What the Usage section shows until a usage comes (ARCHITECTURE 4.3): while
 * the part is asked for and the context's discovery serves the resource,
 * empty meters at the height of the figures, or the sentence the space's API
 * last gave where it was a refusal; nothing where it said `absent`. The
 * states the object brings are kept for the space's next object.
 */
export function useExpectedUsage({
  said,
  space,
  gvr,
  resources,
  asked,
  snapshot,
}: {
  said: UsageSaid;
  /** Undefined for an editor whose address names no object. */
  space: string | undefined;
  gvr: Gvr | undefined;
  resources: Loaded<readonly Resource[]>;
  asked: boolean;
  snapshot: ObjectSnapshot;
}): Expected | undefined {
  const { usage, usageState } = snapshot;
  useEffect(() => {
    if (space !== undefined && usageState !== null) {
      said.say(space, usageState);
    }
  }, [said, space, usageState]);
  if (
    !asked ||
    usage !== undefined ||
    space === undefined ||
    gvr === undefined ||
    !servesUsage(resources, gvr)
  ) {
    return undefined;
  }
  const state = usageState ?? said.get(space);
  if (state === "absent") return undefined;
  return state === "unavailable" || state === "forbidden" ? state : "loading";
}
