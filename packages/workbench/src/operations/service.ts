import type { LucideIcon } from "lucide-react";
import type {
  Backend,
  OperationEvent,
  Plan,
  PlanRequest,
} from "@twigo/protocol";
import { notify } from "@twigo/ui";
import { Changes } from "../changes";
import type { ContextKeys } from "../contextkey/service";

/** The context key that holds while a countdown runs, which ⌘Z cancels. */
export const COUNTING_DOWN = "operationCountingDown";

/** Cancels the newest countdown. */
export const CANCEL_COUNTDOWN = "workbench.action.cancelCountdown";

/** How a command's caller draws its friction: the button's icon, and whether it destroys. */
export interface Look {
  readonly icon: LucideIcon;
  readonly destructive: boolean;
}

/** A plan a dialog asks the person to confirm. */
export interface Asking {
  readonly plan: Plan;
  readonly look: Look;
  readonly confirm: (typed: string | undefined) => void;
  readonly cancel: () => void;
}

/** A run under way that said it waits, for the status bar. */
export interface Running {
  readonly id: number;
  readonly context: string;
  readonly text: string;
  readonly stop: () => void;
}

/** How a run ended, for its caller: a Reveal's value among them. */
export type Outcome =
  | { readonly state: "done" | "stopped" | "cancelled" | "failed" }
  | {
      readonly state: "revealed";
      readonly value: string;
      readonly binary: boolean;
    };

/**
 * The webview's side of the command bus (ARCHITECTURE 5.1, 6.4): asks Rust
 * for a plan, draws the friction it names, runs it with what proves the
 * friction was met, and shows how it goes. Rust decides the friction and
 * checks it again; this only draws it.
 */
export class Operations {
  readonly changes = new Changes();
  #asking: Asking | undefined;
  readonly #running = new Map<number, Running>();
  /** Cancels of the countdowns under way, the newest last. */
  readonly #countdowns: (() => void)[] = [];
  #all: readonly Running[] = [];

  /** `cancelKeys` labels the key that cancels a countdown, if one does. */
  constructor(
    private readonly backend: Backend,
    private readonly keys: ContextKeys,
    private readonly cancelKeys: () => string | undefined,
    private readonly report: (error: unknown) => void,
  ) {}

  get asking(): Asking | undefined {
    return this.#asking;
  }

  /** The same array until the next change, for `useSyncExternalStore`. */
  get running(): readonly Running[] {
    return this.#all;
  }

  /** Plans `request`, asks as its friction says, and runs it once the person agrees. */
  async run(request: PlanRequest, look: Look): Promise<Outcome> {
    let plan: Plan;
    try {
      plan = await this.backend.invoke("command_plan", request);
    } catch (error) {
      this.report(error);
      return { state: "failed" };
    }
    const agreed = await this.#ask(plan, look);
    if (!agreed) {
      this.backend.invoke("command_cancel", plan.id).catch(this.report);
      return { state: "cancelled" };
    }
    return this.#execute(plan, agreed.typed);
  }

  /** Cancels the newest countdown, as ⌘Z does. */
  cancelCountdown(): void {
    this.#countdowns[this.#countdowns.length - 1]?.();
  }

  #ask(
    plan: Plan,
    look: Look,
  ): Promise<{ typed: string | undefined } | undefined> {
    const { friction } = plan;
    if (friction.kind === "atOnce") {
      return Promise.resolve({ typed: undefined });
    }
    if (friction.kind === "countdown") {
      return this.#countdown(plan, friction.seconds, look);
    }
    return new Promise((resolve) => {
      this.#asking?.cancel();
      const done = (answer: { typed: string | undefined } | undefined) => {
        if (this.#asking !== asking) return;
        this.#asking = undefined;
        this.changes.emit();
        resolve(answer);
      };
      const asking: Asking = {
        plan,
        look,
        confirm: (typed) => {
          done({ typed });
        },
        cancel: () => {
          done(undefined);
        },
      };
      this.#asking = asking;
      this.changes.emit();
    });
  }

  #countdown(
    plan: Plan,
    seconds: number,
    look: Look,
  ): Promise<{ typed: undefined } | undefined> {
    return new Promise((resolve) => {
      const until = Date.now() + seconds * 1000;
      const keys = this.cancelKeys();
      // Both set below, before anything can end the countdown.
      const end = (agreed: boolean) => {
        clearTimeout(timer);
        toast.dismiss();
        const index = this.#countdowns.indexOf(cancel);
        if (index >= 0) this.#countdowns.splice(index, 1);
        this.keys.set(COUNTING_DOWN, this.#countdowns.length > 0);
        resolve(agreed ? { typed: undefined } : undefined);
      };
      const cancel = () => {
        end(false);
      };
      const toast = notify.countdown({
        icon: look.icon,
        message: plan.doing,
        detail: (left) => `${plan.context} · sends in ${String(left)} s`,
        until,
        seconds,
        cancel: {
          label: "Cancel",
          ...(keys !== undefined && { keys }),
          run: cancel,
        },
      });
      // Rust counts from the plan, before this starts, so it never answers
      // that the countdown has not ended.
      const timer = setTimeout(() => {
        end(true);
      }, seconds * 1000);
      this.#countdowns.push(cancel);
      this.keys.set(COUNTING_DOWN, true);
    });
  }

  #execute(plan: Plan, typed: string | undefined): Promise<Outcome> {
    return new Promise((resolve) => {
      let ended = false;
      const end = (outcome: Outcome) => {
        if (ended) return;
        ended = true;
        if (this.#running.delete(plan.id)) this.#changed();
        resolve(outcome);
      };
      const stop = () => {
        this.backend.invoke("command_cancel", plan.id).catch(this.report);
      };
      const told = (event: OperationEvent) => {
        switch (event.state) {
          case "running":
            if (ended) return;
            this.#running.set(plan.id, {
              id: plan.id,
              context: plan.context,
              text: event.text,
              stop,
            });
            this.#changed();
            return;
          case "done":
            notify.success(event.text);
            end({ state: "done" });
            return;
          case "stopped":
            notify.info(event.text);
            end({ state: "stopped" });
            return;
          case "revealed":
            end({
              state: "revealed",
              value: event.value,
              binary: event.binary,
            });
            return;
          case "failed":
            this.report(event.error);
            end({ state: "failed" });
            return;
        }
      };
      this.backend
        .subscribe(
          "command_execute",
          { plan: plan.id, typed: typed ?? null },
          told,
        )
        .catch((error: unknown) => {
          this.report(error);
          end({ state: "failed" });
        });
    });
  }

  #changed(): void {
    this.#all = [...this.#running.values()];
    this.changes.emit();
  }
}
