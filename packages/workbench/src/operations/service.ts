import { CircleCheck, LockOpen, Tag, type LucideIcon } from "lucide-react";
import type {
  Backend,
  Environment,
  OperationEvent,
  Plan,
  PlanId,
  PlanRequest,
  SubscriptionId,
} from "@twigo/protocol";
import { toIpcError } from "@twigo/protocol";
import { notify, type ToastAction } from "@twigo/ui";
import { Changes } from "../changes";
import type { ContextKeys } from "../contextkey/service";
import { spaceMark } from "../parts/spaceMark";
import type { QuickPickItem } from "../quickaccess/registry";
import {
  ENVIRONMENTS,
  environmentHelp,
  environmentLabel,
} from "../spaces/modes";
import type { Spaces } from "../spaces/store";
import { variant } from "../variants";
import { unlockAction } from "./unlock";

/** The context key that holds while a countdown runs, which ⌘Z cancels. */
export const COUNTING_DOWN = "operationCountingDown";

/** Cancels the newest countdown. */
export const CANCEL_COUNTDOWN = "workbench.action.cancelCountdown";

/** The context key that lists the spaces whose last action an undo puts back now. */
export const UNDOABLE = "operationUndo";

/** Puts back the active space's last action (decision 5 of M2). */
export const UNDO = "workbench.action.undo";

/** How a command's caller draws its friction: the button's icon; the plan says whether it destroys. */
export interface Look {
  readonly icon: LucideIcon;
}

/** A plan a dialog asks the person to confirm. */
export interface Asking {
  readonly plan: Plan;
  readonly look: Look;
  readonly confirm: (typed: string | undefined) => void;
  readonly cancel: () => void;
}

/** The question what a context nobody marked is, which a dialog asks. */
export interface Marking {
  readonly context: string;
  readonly choose: (environment: Environment) => void;
  readonly cancel: () => void;
}

/** A run under way that said it waits, for the status bar. */
export interface Running {
  readonly id: number;
  readonly context: string;
  readonly text: string;
  readonly stop: () => void;
}

/** The space a request is for; a Reveal, a shell and a change of protection name none. */
function spaceOf(request: PlanRequest): string | undefined {
  return "space" in request ? request.space : undefined;
}

/** A space's undo while it lasts. */
interface Undo {
  readonly look: Look;
  /** While its own run is planned or goes, so a second ⌘Z waits. */
  undoing: boolean;
  /** Its own plan, while a dialog may ask about it. */
  plan?: PlanId;
  readonly dismiss: () => void;
}

/**
 * How a run ended, for its caller: a Reveal's value and a shell's session
 * among them. `refused` is a plan the gate refused, before anything was
 * asked or taken, so what the plan was of, a preview among it, is still
 * there.
 */
export type Outcome =
  | {
      readonly state: "done" | "stopped" | "cancelled" | "failed" | "refused";
    }
  | {
      readonly state: "revealed";
      readonly value: string;
      readonly binary: boolean;
    }
  | {
      readonly state: "session";
      readonly id: SubscriptionId;
      readonly tty: boolean;
      readonly stdin: boolean;
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
  #marking: Marking | undefined;
  /** How many quick picks that ask what a context is are open. */
  #picks = 0;
  readonly #running = new Map<number, Running>();
  /** The countdowns under way, the newest last, by what they plan. */
  readonly #countdowns: {
    readonly request: string;
    readonly cancel: () => void;
  }[] = [];
  #all: readonly Running[] = [];
  /** Each space's undo while it lasts, by space. */
  readonly #undos = new Map<string, Undo>();
  /** The run of each space that started last, as Rust counts its last action. */
  readonly #latest = new Map<string, PlanId>();

  /** `cancelKeys` and `undoKeys` label the keys that cancel a countdown and undo, if any do. */
  constructor(
    private readonly backend: Backend,
    private readonly keys: ContextKeys,
    private readonly cancelKeys: () => string | undefined,
    private readonly undoKeys: () => string | undefined,
    private readonly report: (error: unknown) => void,
    private readonly spaces: Pick<Spaces, "get" | "ofContext">,
    private readonly pick: (
      placeholder: string,
      items: readonly QuickPickItem[],
    ) => Promise<QuickPickItem | undefined>,
  ) {}

  /**
   * What leads a toast about a run: the tile of its space, which stays
   * whichever space is shown. A request that names no space, a Reveal or a
   * shell, has its context stand for one.
   */
  #tile(space: string | undefined, context: string | undefined) {
    if (space !== undefined) return spaceMark(this.spaces.get(space));
    return spaceMark(
      context === undefined ? undefined : this.spaces.ofContext(context),
    );
  }

  get asking(): Asking | undefined {
    return this.#asking;
  }

  get marking(): Marking | undefined {
    return this.#marking;
  }

  /** Whether a plan's confirmation or the question of what a context is is open, in a dialog or in quick access, which the asks of processes wait behind. */
  get confirming(): boolean {
    return (
      this.#asking !== undefined ||
      this.#marking !== undefined ||
      this.#picks > 0
    );
  }

  /** The same array until the next change, for `useSyncExternalStore`. */
  get running(): readonly Running[] {
    return this.#all;
  }

  /** Plans `request`, asks as its friction says, and runs it once the person agrees. */
  run(request: PlanRequest, look: Look): Promise<Outcome> {
    return this.#run(request, look, undefined);
  }

  /** Lifts a read-only context's lock for 15 minutes, which asks in a dialog. */
  unlock(context: string): Promise<Outcome> {
    return this.run({ action: "unlock", context }, { icon: LockOpen });
  }

  /** As `run`, for the undo it puts back, if it does. */
  async #run(
    request: PlanRequest,
    look: Look,
    undo: Undo | undefined,
  ): Promise<Outcome> {
    let plan: Plan;
    try {
      plan = await this.backend.invoke("command_plan", request);
    } catch (error) {
      const { blocked } = toIpcError(error);
      if (blocked?.reason === "unmarked") {
        const marked = await this.#mark(blocked.context);
        return marked.state === "done"
          ? this.#run(request, look, undo)
          : marked;
      }
      this.#fail(error, spaceOf(request), unlockAction(this, error));
      return {
        state: toIpcError(error).blocked === undefined ? "failed" : "refused",
      };
    }
    if (undo) {
      if (
        request.action === "undo" &&
        this.#undos.get(request.space) !== undo
      ) {
        this.backend.invoke("command_cancel", plan.id).catch(this.report);
        return { state: "cancelled" };
      }
      undo.plan = plan.id;
    }
    const agreed = await this.#ask(plan, look, request);
    if (!agreed) {
      this.backend.invoke("command_cancel", plan.id).catch(this.report);
      return { state: "cancelled" };
    }
    // An undo takes its own and leaves a later one standing, as in Rust; a
    // Reveal and a shell change nothing an undo could put back.
    const space = request.action === "undo" ? undefined : spaceOf(request);
    // Rust takes the undo as its run starts; a refused one leaves it.
    const taken =
      undo && space === undefined && request.action === "undo"
        ? () => {
            if (this.#undos.get(request.space) === undo) {
              this.#drop(request.space);
            }
          }
        : undefined;
    return this.#execute(
      plan,
      agreed.typed,
      space,
      spaceOf(request),
      look,
      taken,
    );
  }

  /**
   * Asks what a context nobody marked is, as the first write or exec to it
   * does, and marks it as the person answers, which a plan of its own does
   * (ARCHITECTURE 6.4). Anything but `done` leaves the command it came from
   * unsent.
   */
  async #mark(context: string): Promise<Outcome> {
    const environment =
      variant("ask") === "pick"
        ? await this.#pickEnvironment(context)
        : await this.#askEnvironment(context);
    if (environment === undefined) return { state: "cancelled" };
    return this.#run(
      { action: "setEnvironment", context, environment },
      { icon: Tag },
      undefined,
    );
  }

  async #pickEnvironment(context: string): Promise<Environment | undefined> {
    this.#picks++;
    this.changes.emit();
    try {
      const picked = await this.pick(
        `What is ${context}?`,
        ENVIRONMENTS.map((environment) => ({
          id: environment,
          label: environmentLabel(environment),
          description: environmentHelp(environment),
        })),
      );
      return ENVIRONMENTS.find((environment) => environment === picked?.id);
    } finally {
      this.#picks--;
      this.changes.emit();
    }
  }

  #askEnvironment(context: string): Promise<Environment | undefined> {
    return new Promise((resolve) => {
      this.#marking?.cancel();
      const done = (environment: Environment | undefined) => {
        if (this.#marking !== marking) return;
        this.#marking = undefined;
        this.changes.emit();
        resolve(environment);
      };
      const marking: Marking = {
        context,
        choose: done,
        cancel: () => {
          done(undefined);
        },
      };
      this.#marking = marking;
      this.changes.emit();
    });
  }

  /** Puts back the space's last action while its undo lasts, as ⌘Z does; a second press while it goes does nothing. */
  async undo(space: string): Promise<Outcome> {
    const undo = this.#undos.get(space);
    if (!undo || undo.undoing) return { state: "cancelled" };
    undo.undoing = true;
    const outcome = await this.#run({ action: "undo", space }, undo.look, undo);
    undo.undoing = false;
    return outcome;
  }

  /** Cancels the newest countdown, as ⌘Z does. */
  cancelCountdown(): void {
    this.#countdowns[this.#countdowns.length - 1]?.cancel();
  }

  /**
   * Says why a plan was refused or a run failed, led by its space's tile as
   * what the run says when it goes well is. A context that is read-only by
   * what the person may lift offers the unlock right there (`action`), which
   * a policy file's lock or a context no source lists does not.
   */
  #fail(error: unknown, space: string | undefined, action?: ToastAction): void {
    const { message, blocked } = toIpcError(error);
    notify.error(message, {
      key: message,
      tile: this.#tile(space, blocked?.context),
      ...(action && { action }),
    });
  }

  #ask(
    plan: Plan,
    look: Look,
    request: PlanRequest,
  ): Promise<{ typed: string | undefined } | undefined> {
    const { friction } = plan;
    if (friction.kind === "atOnce") {
      return Promise.resolve({ typed: undefined });
    }
    if (friction.kind === "countdown") {
      return this.#countdown(plan, friction.seconds, look, request);
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

  /** The request names what the plan acts on, so a second countdown of it replaces the first. */
  #countdown(
    plan: Plan,
    seconds: number,
    look: Look,
    asked: PlanRequest,
  ): Promise<{ typed: undefined } | undefined> {
    const request = JSON.stringify(asked);
    this.#countdowns.find((other) => other.request === request)?.cancel();
    return new Promise((resolve) => {
      const until = Date.now() + seconds * 1000;
      const keys = this.cancelKeys();
      let ended = false;
      // Both set below, before anything can end the countdown; dismissing
      // the toast cancels it, so the first end stands.
      const end = (agreed: boolean) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        const index = this.#countdowns.indexOf(entry);
        if (index >= 0) this.#countdowns.splice(index, 1);
        this.keys.set(COUNTING_DOWN, this.#countdowns.length > 0);
        resolve(agreed ? { typed: undefined } : undefined);
        toast.dismiss();
      };
      const cancel = () => {
        end(false);
      };
      const toast = notify.countdown({
        tile: this.#tile(spaceOf(asked), plan.context),
        icon: look.icon,
        message: plan.doing,
        detail: (left) => `${plan.context} · sends in ${String(left)}\u00a0s`,
        until,
        seconds,
        action: {
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
      const entry = { request, cancel };
      this.#countdowns.push(entry);
      this.keys.set(COUNTING_DOWN, true);
    });
  }

  #execute(
    plan: Plan,
    typed: string | undefined,
    space: string | undefined,
    home: string | undefined,
    look: Look,
    taken: (() => void) | undefined,
  ): Promise<Outcome> {
    return new Promise((resolve) => {
      let ended = false;
      let begun = false;
      // Once Rust took the run, which a refused one it did not, the space's
      // last action is this one.
      const begin = () => {
        if (begun) return;
        begun = true;
        taken?.();
        if (space === undefined) return;
        this.#latest.set(space, plan.id);
        this.#drop(space);
      };
      const end = (
        outcome: Outcome,
        done?: { text: string; undoUntil: number | null },
      ) => {
        if (ended) return;
        ended = true;
        if (this.#running.delete(plan.id)) this.#changed();
        const undoUntil = done?.undoUntil ?? null;
        if (
          space !== undefined &&
          done !== undefined &&
          undoUntil !== null &&
          begun &&
          this.#latest.get(space) === plan.id
        ) {
          this.#offer(space, plan.context, look, done.text, undoUntil);
        } else if (done !== undefined) {
          notify.success(done.text, {
            tile: this.#tile(home, plan.context),
          });
        }
        resolve(outcome);
      };
      const stop = () => {
        this.backend.invoke("command_cancel", plan.id).catch(this.report);
      };
      const told = (event: OperationEvent) => {
        begin();
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
            end({ state: "done" }, event);
            return;
          case "stopped":
            notify.info(event.text, {
              tile: this.#tile(home, plan.context),
            });
            end({ state: "stopped" });
            return;
          case "revealed":
            end({
              state: "revealed",
              value: event.value,
              binary: event.binary,
            });
            return;
          case "session":
            end({
              state: "session",
              id: event.id,
              tty: event.tty,
              stdin: event.stdin,
            });
            return;
          case "failed":
            this.#fail(event.error, home);
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
        .then(begin, (error: unknown) => {
          this.#fail(error, home);
          end({ state: "failed" });
        });
    });
  }

  #changed(): void {
    this.#all = [...this.#running.values()];
    this.changes.emit();
  }

  /** Ends a space's undo and its toast. */
  #drop(space: string): void {
    const undo = this.#undos.get(space);
    if (!undo) return;
    undo.dismiss();
    this.#undos.delete(space);
    this.#undoable();
    // A dialog that asks about an undo that ended asks about nothing.
    if (undo.plan !== undefined && this.#asking?.plan.id === undo.plan) {
      this.#asking.cancel();
    }
  }

  /** Offers a space's undo until it ends, its toast going with it. */
  #offer(
    space: string,
    context: string,
    look: Look,
    text: string,
    until: number,
  ): void {
    const keys = this.undoKeys();
    const toast = notify.undoable({
      tile: this.#tile(space, context),
      icon: CircleCheck,
      message: text,
      detail: (left) => `${context} · undo for ${String(left)}\u00a0s`,
      until,
      seconds: Math.max(1, Math.round((until - Date.now()) / 1000)),
      action: {
        label: "Undo",
        ...(keys !== undefined && { keys }),
        run: () => {
          this.undo(space).catch(this.report);
        },
      },
    });
    const timer = setTimeout(() => {
      if (this.#undos.get(space) === undo) this.#drop(space);
    }, until - Date.now());
    const undo: Undo = {
      look,
      undoing: false,
      dismiss: () => {
        clearTimeout(timer);
        toast.dismiss();
      },
    };
    this.#undos.set(space, undo);
    this.#undoable();
  }

  #undoable(): void {
    this.keys.set(UNDOABLE, [...this.#undos.keys()]);
  }
}
