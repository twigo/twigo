import type { Backend } from "../backend";
import { IpcError } from "../error";
import type { PlanRequest } from "../generated";

type Protection = Extract<
  PlanRequest,
  { action: "setMode" | "setEnvironment" | "unlock" }
>;

/** Lets the mock's timers run: a test on fake timers moves the clock instead, 1 ms at least, as a timer set from a timer's callback waits that long. */
type Tick = () => Promise<unknown>;

const TIMER: Tick = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/** Ticks until `promise` has answered, since each of the mock's answers is a timer set once the one before has gone out. */
async function ticked<T>(promise: Promise<T>, tick: Tick): Promise<T> {
  const state = { answered: false };
  const done = () => {
    state.answered = true;
  };
  promise.then(done, done);
  while (!state.answered) await tick();
  return promise;
}

async function change(backend: Backend, request: Protection): Promise<void> {
  const plan = await backend.invoke("command_plan", request);
  const typed = plan.friction.kind === "typed" ? plan.friction.text : null;
  await new Promise<void>((resolve, reject) => {
    backend
      .subscribe("command_execute", { plan: plan.id, typed }, (event) => {
        if (event.state === "done") resolve();
        else if (event.state === "failed") {
          reject(new IpcError(event.error.kind, event.error.message));
        }
      })
      .catch(reject);
  });
}

/**
 * Changes a context's protection as a test of the UI needs it done: planned
 * and run at once with what the friction asks, a name typed included, and
 * done when the mock says it is.
 */
export function protect(
  backend: Backend,
  request: Protection,
  tick: Tick = TIMER,
): Promise<void> {
  return ticked(change(backend, request), tick);
}
