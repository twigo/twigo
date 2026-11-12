import { ArrowLeftRight } from "lucide-react";
import { useChanges, type StatusEntry, type Workbench } from "@twigo/workbench";
import { showForwards } from "./actions";
import type { Forwards } from "./service";
import { forwardTitle, listensOn, stateOf } from "./words";

/**
 * The one entry for the active space's forwards (ARCHITECTURE 4.1), absent
 * while none is running: a stopped forward is not running. It counts those
 * that listen, which a failed one still does unless its local port was held
 * when it was restored. It warns while a running one fails or reconnects,
 * counted or not, and its tooltip names the running ones, a forward that
 * listens nowhere as not listening.
 */
export function forwardEntries(
  workbench: Workbench,
  forwards: Forwards,
): () => readonly StatusEntry[] {
  return () => {
    useChanges(forwards.changes);
    useChanges(workbench.spaces.changes);
    const space = workbench.spaces.active?.id;
    const running = space === undefined ? [] : forwards.running(space);
    if (running.length === 0) return [];
    const listening = running.filter(
      (forward) => listensOn(forward).length > 0,
    );
    const names = running.map((forward) => {
      const { state } = forward.state;
      const trouble = state === "failed" || state === "reconnecting";
      const notes = [
        ...(trouble ? [stateOf(forward).label.toLowerCase()] : []),
        ...(listening.includes(forward) ? [] : ["not listening"]),
      ];
      const title = forwardTitle(forward);
      return notes.length > 0 ? `${title} (${notes.join(", ")})` : title;
    });
    const warns = running.some(
      ({ state }) => state.state === "failed" || state.state === "reconnecting",
    );
    return [
      {
        id: "forwards",
        text:
          listening.length === 1
            ? "1 forward"
            : `${String(listening.length)} forwards`,
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
