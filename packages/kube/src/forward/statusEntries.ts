import { ArrowLeftRight } from "lucide-react";
import { useChanges, type StatusEntry, type Workbench } from "@twigo/workbench";
import { showForwards } from "./actions";
import type { Forwards } from "./service";
import { forwardTitle, stateOf } from "./words";

/**
 * The one entry for the active space's running forwards (ARCHITECTURE 4.1),
 * absent while there are none: a stopped forward is not running, a failed one
 * still listens. It warns while one of them fails or reconnects, and its
 * tooltip names them.
 */
export function forwardEntries(
  workbench: Workbench,
  forwards: Forwards,
): () => readonly StatusEntry[] {
  return () => {
    useChanges(forwards.changes);
    useChanges(workbench.spaces.changes);
    const space = workbench.spaces.active?.id;
    const running =
      space === undefined
        ? []
        : forwards
            .ofSpace(space)
            .filter(({ state }) => state.state !== "stopped");
    if (running.length === 0) return [];
    const names = running.map((forward) => {
      const { state } = forward.state;
      const trouble = state === "failed" || state === "reconnecting";
      const title = forwardTitle(forward);
      return trouble
        ? `${title} (${stateOf(forward).label.toLowerCase()})`
        : title;
    });
    const warns = running.some(
      ({ state }) => state.state === "failed" || state.state === "reconnecting",
    );
    return [
      {
        id: "forwards",
        text:
          running.length === 1
            ? "1 forward"
            : `${String(running.length)} forwards`,
        icon: ArrowLeftRight,
        ...(warns && { tone: "warn" as const }),
        tooltip: `Port forwards: ${names.join(", ")}`,
        run: () => {
          showForwards(workbench);
        },
      },
    ];
  };
}
