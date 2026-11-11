import type { Workbench } from "@twigo/workbench";
import type { Forwards } from "./service";

/**
 * Port-forwards (ARCHITECTURE 4.6): this window follows the core's, which
 * outlive it, and everything that draws or acts on a forward reads the
 * service.
 */
export function registerForwards(
  workbench: Workbench,
  forwards: Forwards,
): void {
  forwards.watch().catch((error: unknown) => {
    workbench.report(error);
  });
}
