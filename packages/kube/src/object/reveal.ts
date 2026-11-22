import { useMemo } from "react";
import { Eye } from "lucide-react";
import type { PlanRequest, SubscriptionId } from "@twigo/protocol";
import { useWorkbench } from "@twigo/workbench";

/** A Secret's value of a key, once revealed; none when the person did not confirm or it failed. */
export type Reveal = (
  key: string,
) => Promise<{ value: string; binary: boolean } | undefined>;

/**
 * Reveals what `request` asks the command bus for (ARCHITECTURE 3.6, 6.4),
 * which asks first in a guarded or read-only context: a Secret's key, or a
 * part of a Helm release. The value stays with the caller, which drops it as
 * the Reveal ends.
 */
export function useReveal<A>(
  request: ((argument: A) => Promise<PlanRequest>) | undefined,
):
  | ((argument: A) => Promise<{ value: string; binary: boolean } | undefined>)
  | undefined {
  const workbench = useWorkbench();
  const { operations } = workbench;
  return useMemo(
    () =>
      request &&
      (async (argument: A) => {
        let planned: PlanRequest;
        try {
          planned = await request(argument);
        } catch (error) {
          workbench.report(error);
          return undefined;
        }
        const outcome = await operations.run(planned, { icon: Eye });
        return outcome.state === "revealed"
          ? { value: outcome.value, binary: outcome.binary }
          : undefined;
      }),
    [request, operations, workbench],
  );
}

/** The Reveal of a key of the open Secret `id` names. */
export function useSecretReveal(
  id: (() => Promise<SubscriptionId>) | undefined,
): Reveal | undefined {
  const request = useMemo(
    () =>
      id &&
      (async (key: string): Promise<PlanRequest> => ({
        action: "reveal",
        object: await id(),
        key,
      })),
    [id],
  );
  return useReveal(request);
}
