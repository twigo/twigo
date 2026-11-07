import { useChanges, useWorkbench } from "../react";
import { accessOfSpace } from "../spaces/modes";

/**
 * The active space's strong cues (ARCHITECTURE 6.4): a production context
 * is a mode, so it gets a second cue on a large surface, while every other
 * context has its chip only.
 */
export function useModeCues(): { readonly strong: boolean } {
  const { spaces, catalog } = useWorkbench();
  useChanges(spaces.changes);
  useChanges(catalog.changes);
  const space = spaces.active;
  const access = space && accessOfSpace(catalog, space);
  return { strong: access?.environment === "production" };
}
