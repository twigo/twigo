import { useChanges, useWorkbench } from "../react";
import { accessOfSpace } from "../spaces/modes";

/**
 * @todo: remove `?variant=` once Serhii picks one at step 1's checkpoint.
 * a: Production only, as the mockup accepted on 2026-11-03.
 * b: Production, and any context that holds writes back.
 * c: every context someone marked.
 */
const variant = new URLSearchParams(location.search).get("variant") ?? "a";

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
  if (!access) return { strong: false };
  const production = access.environment === "production";
  if (variant === "b")
    return { strong: production || access.mode !== "read-write" };
  if (variant === "c") return { strong: access.environment !== null };
  return { strong: production };
}
