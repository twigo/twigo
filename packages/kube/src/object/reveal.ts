import { useMemo } from "react";
import { Eye } from "lucide-react";
import type { SubscriptionId } from "@twigo/protocol";
import { useWorkbench } from "@twigo/workbench";

/** A Secret's value of a key, once revealed; none when the person did not confirm or it failed. */
export type Reveal = (
  key: string,
) => Promise<{ value: string; binary: boolean } | undefined>;

/**
 * Reveals a value of the open Secret `id` names through the command bus
 * (ARCHITECTURE 3.6, 6.4), which asks first in a guarded or read-only
 * context. The value stays with the caller, which drops it as the Reveal
 * ends.
 */
export function useReveal(
  id: (() => Promise<SubscriptionId>) | undefined,
): Reveal | undefined {
  const { operations } = useWorkbench();
  return useMemo(
    () =>
      id &&
      (async (key: string) => {
        const object = await id();
        const outcome = await operations.run(
          { action: "reveal", object, key },
          { icon: Eye, destructive: false },
        );
        return outcome.state === "revealed"
          ? { value: outcome.value, binary: outcome.binary }
          : undefined;
      }),
    [id, operations],
  );
}
