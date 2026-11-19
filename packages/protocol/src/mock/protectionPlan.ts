import type {
  ContextAccess,
  Environment,
  Friction,
  Lock,
  LockSource,
  Mode,
  ModeSource,
} from "../generated";
import {
  STRICTNESS,
  type Change,
  type MockAccess,
  type Outlived,
} from "./access";

const UNLOCK_MINUTES = 15;

const OPENED = "Writes and shells are no longer refused";

const ENVIRONMENT_NAME: Readonly<Record<Environment, string>> = {
  production: "Production",
  staging: "Staging",
  development: "Development",
  local: "Local",
};

/** What a change of protection says of itself, as `actions::protection` in Rust does. */
export interface Words {
  readonly question: string;
  readonly confirm: string;
  readonly doing: string;
  readonly done: string;
  readonly consequences: string[];
}

/** A context's access before and after a change. */
export interface Step {
  readonly from: ContextAccess;
  readonly to: ContextAccess;
}

/**
 * The context as it would be with the locks `gone` taken away, the person's
 * mode and type kept: `twigo_policy::Beneath`.
 */
export interface Beneath extends Step {
  readonly gone: readonly Outlived[];
}

/** What a change leaves a context with, as `twigo_policy::Policy::plan` says: its access as it is, and under each nonempty set of the locks that hold it taken away, the smallest sets first. */
export interface Weighed extends Step {
  readonly beneath: readonly Beneath[];
}

export function weigh(
  access: Pick<MockAccess, "of" | "would" | "without" | "locks">,
  context: string,
  change: Change,
): Weighed {
  const beneath = sets(access.locks(context))
    .filter((gone) => gone.length > 0)
    .map((gone) => ({
      gone,
      from: access.without(context, gone),
      to: access.without(context, gone, change),
    }));
  return {
    from: access.of(context),
    to: access.would(context, change),
    beneath,
  };
}

/** Every set of `locks`, the smallest first and each size in the order the locks come, as `twigo_policy::policy::sets` does. */
function sets<T>(locks: readonly T[]): T[][] {
  let all: T[][] = [[]];
  for (const lock of locks) all = [...all, ...all.map((set) => [...set, lock])];
  return all.sort((a, b) => a.length - b.length);
}

/**
 * What a lasting change of a context's protection asks, as
 * `twigo_policy::friction::friction` does: its name typed when, as it is
 * (the first of `steps`) or under any set of the locks that can go taken
 * away (the others), it leaves the context less strict than the mode it
 * keeps; nothing when it tightens or keeps that in every one, or when the
 * context is unmarked now, as the question it answers is its friction.
 */
export function lowering(
  context: string,
  access: ContextAccess,
  steps: readonly Step[],
): Friction {
  return access.source.kind === "unmarked" || steps.every(keeps)
    ? { kind: "atOnce" }
    : { kind: "typed", text: context };
}

/**
 * Whether the change leaves the context at least as strict as the mode it
 * keeps, an unlock counting as `read-only`. Leaving a context unmarked weighs
 * as `read-write`, since any change from there runs at once, unless it was
 * unmarked already, and then it counts as `guarded`.
 */
function keeps({ from, to }: Step): boolean {
  const unmarked = ({ source }: ContextAccess) => source.kind === "unmarked";
  const leaves = unmarked(to) && !unmarked(from) ? "read-write" : to.mode;
  const kept = from.unlockedUntil === null ? from.mode : "read-only";
  return STRICTNESS[leaves] >= STRICTNESS[kept];
}

export function words(
  context: string,
  change: Change,
  before: ContextAccess,
  after: ContextAccess,
  beneath: readonly Beneath[],
): Words {
  return {
    ...question(context, change, after),
    consequences: consequences(context, change, before, after, beneath),
  };
}

function question(
  context: string,
  change: Change,
  after: ContextAccess,
): Omit<Words, "consequences"> {
  const { mode } = after;
  if ("unlock" in change) {
    return {
      question: `Unlock ${context} for ${String(UNLOCK_MINUTES)} minutes?`,
      confirm: `Unlock for ${String(UNLOCK_MINUTES)} minutes`,
      doing: `Unlocking ${context}`,
      done: `Unlocked ${context} for ${String(UNLOCK_MINUTES)} minutes`,
    };
  }
  if ("mode" in change) {
    return {
      question:
        change.mode === null
          ? `Make ${context} ${mode}${why(after.source)}, in place of your mode?`
          : `Make ${context} ${mode}?`,
      confirm: `Make ${mode}`,
      doing: `Making ${context} ${mode}`,
      done: `Made ${context} ${mode}`,
    };
  }
  if (change.environment === null) {
    return {
      question: `Clear the type of ${context}, whatever its kubeconfig says?`,
      confirm: "Clear type",
      doing: `Clearing the type of ${context}`,
      done: `Cleared the type of ${context}`,
    };
  }
  const type = ENVIRONMENT_NAME[change.environment];
  return {
    question: `Mark ${context} as ${type}?`,
    confirm: `Mark as ${type}`,
    doing: `Marking ${context} as ${type}`,
    done: `Marked ${context} as ${type}`,
  };
}

function consequences(
  context: string,
  change: Change,
  before: ContextAccess,
  after: ContextAccess,
  views: readonly Beneath[],
): string[] {
  const unlock = "unlock" in change;
  const was =
    before.source.kind === "unmarked"
      ? null
      : before.unlockedUntil === null
        ? before.mode
        : "read-only";
  const said: string[] = [];
  if (after.source.kind === "unmarked") {
    said.push(
      `Its first write or exec asks what ${context} is, and nothing is sent until you say.`,
    );
  } else if (was === after.mode && !unlock) {
    said.push(`It stays ${after.mode}${why(after.source)}.`);
  } else {
    said.push(...asks(context, after.mode, was));
  }
  if (!unlock) said.push(...beneath(context, after, views));
  if (after.source.kind === "user" && after.source.overrides !== null) {
    const { mode, source }: Lock = after.source.overrides;
    said.push(`It sets aside the ${mode} ${lockedBy(source)}.`);
  }
  if (unlock) {
    said.push(`It relocks by itself in ${String(UNLOCK_MINUTES)} minutes.`);
  } else if (before.unlockedUntil !== null) {
    said.push("Its unlock ends.");
  }
  return said;
}

/**
 * What the change gives once locks that hold the context go, where that is
 * not what it gives now: the person's mode and type outlive them. Of the
 * sets of locks whose absence shows it, the one that leaves the context
 * least strict, and of those the smallest.
 */
function beneath(
  context: string,
  after: ContextAccess,
  views: readonly Beneath[],
): string[] {
  const unmarked = ({ source }: ContextAccess) => source.kind === "unmarked";
  const strictness = ({ to }: Beneath) =>
    STRICTNESS[to.mode] * 2 + (unmarked(to) ? 0 : 1);
  const view = views
    .filter(
      ({ to }) => to.mode !== after.mode || unmarked(to) !== unmarked(after),
    )
    .reduce<Beneath | undefined>(
      (least, next) =>
        least === undefined || strictness(next) < strictness(least)
          ? next
          : least,
      undefined,
    );
  if (view === undefined) return [];
  const gone = view.gone.map((lock) => {
    switch (lock.kind) {
      case "policyFile":
        return `${lock.file} no longer sets its mode`;
      case "kubeconfig":
        return "its kubeconfig's lock goes";
      case "type":
        return "its kubeconfig's type goes";
    }
  });
  const then = unmarked(view.to)
    ? `its first write or exec asks what ${context} is`
    : `it will be ${view.to.mode}`;
  return [`When ${gone.join(" and ")}, ${then}.`];
}

/** What `mode` asks of the person and of processes, said as what changes from `was`, none for a context nobody had marked. */
function asks(context: string, mode: Mode, was: Mode | null): string[] {
  const refused = was === null || was === "read-only";
  const unmarked = was === null;
  switch (mode) {
    case "read-write": {
      const opened = refused
        ? OPENED
        : `Writes stop asking for ${context}'s name`;
      return [
        `${opened}: a scale, an apply or a shell runs at once, and a delete asks in a dialog.`,
        "Processes in its terminals write and exec without asking, and new terminals use your own kubeconfig.",
      ];
    }
    case "guarded": {
      const write = `write asks for ${context}'s name typed, and a shell or an apply asks in a dialog.`;
      return [
        refused ? `${OPENED}: each ${write}` : `Each ${write}`,
        unmarked
          ? `A process's write or exec in its terminals asks you to allow it, rather than what ${context} is.`
          : "A process's write or exec in its terminals waits for your answer.",
      ];
    }
    case "read-only":
      return unmarked
        ? [
            "Every write, exec and shell stays refused; reads, dry runs and port-forwards go on.",
            `A process's write or exec in its terminals is refused, rather than asking what ${context} is.`,
          ]
        : [
            "Every write, exec and shell is refused; reads, dry runs and port-forwards go on.",
          ];
  }
}

/** Why a context has its mode, after the mode in a sentence. */
function why(source: ModeSource): string {
  switch (source.kind) {
    case "user":
      return " by your choice";
    case "kubeconfig":
      return " as its kubeconfig says";
    case "provider":
      return " as its provider says";
    case "environment":
      return ` as ${ENVIRONMENT_NAME[source.environment]} by default`;
    case "unmarked":
      return " until you say what it is";
    case "policyFile":
      return source.pattern === null
        ? ` because ${source.file} cannot be read`
        : ` by ${source.pattern} in ${source.file}`;
    case "unlisted":
    case "moved":
      return "";
  }
}

function lockedBy(source: LockSource): string {
  switch (source.kind) {
    case "kubeconfig":
      return "its kubeconfig sets";
    case "provider":
      return "its provider sets";
    case "environment":
      return `${ENVIRONMENT_NAME[source.environment]} sets by default`;
  }
}
