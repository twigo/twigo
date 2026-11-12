import { toIpcError, type Forward, type ForwardStarted } from "@twigo/protocol";
import { notify } from "@twigo/ui";
import type { Workbench } from "@twigo/workbench";
import type { Forwards } from "./service";
import { variant } from "./variants";
import { targetWords } from "./words";

type Busy = Extract<ForwardStarted, { outcome: "busy" }>;

/** Why a local port could not be bound, in words that tell the two apart. */
function whyBusy({ local, why }: Busy): string {
  return why === "inUse"
    ? `${String(local)} is in use by another process or forward`
    : `Twigo cannot listen on ${String(local)}: ports below 1024 need privileges it does not have`;
}

export function validPort(value: string): string | undefined {
  const port = Number(value.trim());
  return /^\d{1,5}$/.test(value.trim()) && port >= 1 && port <= 65535
    ? undefined
    : "Type a port from 1 to 65535";
}

/**
 * Runs a start or a resume. One that the context's mode refuses answers the
 * gate's error and changes nothing (ARCHITECTURE 4.6), so it is told here as
 * a warning in the gate's words and nothing is returned; any other failure
 * goes on to be reported.
 */
export async function unlessRefused<T>(
  what: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    const { blocked, message } = toIpcError(error);
    if (blocked === undefined) throw error;
    notify.warning(`${what} is not forwarded: ${message}`, {
      key: `forward-refused:${what}`,
    });
    return undefined;
  }
}

/**
 * What a start or a resume answered. A forward is handed to `done`; a port
 * that could not be bound starts nothing, and the next free one is offered
 * as data, never taken by itself: a toast to accept it, or a field with it
 * filled in. The person's choice goes through `again`, which asks the core
 * with that port, and its answer is told the same way.
 */
export async function tellBind(
  workbench: Workbench,
  started: ForwardStarted,
  what: string,
  again: (local: number) => Promise<ForwardStarted>,
  done: (forward: Forward) => void,
): Promise<void> {
  if (started.outcome === "started") {
    done(started.forward);
    return;
  }
  const retry = async (local: number): Promise<void> => {
    try {
      const answer = await unlessRefused(what, () => again(local));
      if (answer) await tellBind(workbench, answer, what, again, done);
    } catch (error) {
      workbench.report(error);
    }
  };
  const words = whyBusy(started);
  if (variant("busy") === "input") {
    const typed = await workbench.quickAccess.input({
      placeholder: "Local port",
      prompt: `${words}. Enter forwards ${what} on the port above.`,
      acceptLabel: "Forward",
      value: String(started.free),
      validate: validPort,
    });
    if (typed !== undefined) await retry(Number(typed.trim()));
    return;
  }
  notify.warning(`${words}, so ${what} is not forwarded.`, {
    key: `forward-busy:${what}`,
    action: {
      label: `Use ${String(started.free)}`,
      run: () => {
        void retry(started.free);
      },
    },
  });
}

/**
 * Tells a start that did not come to be: a forward that fails before it was
 * ever ready says the target's own failure, which neither bind answer does.
 */
export function tellFailure(forwards: Forwards): (forward: Forward) => void {
  return (forward) => {
    void forwards.settled(forward).then((settled) => {
      if (settled?.state.state !== "failed") return;
      const { error } = settled.state;
      const tell = error.blocked ? notify.warning : notify.error;
      tell(
        `${targetWords(settled)} → ${String(settled.local)} failed: ${error.message}`,
        { key: `forward-failed:${String(settled.id)}` },
      );
    });
  };
}
