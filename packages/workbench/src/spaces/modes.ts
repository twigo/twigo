import type {
  ContextAccess,
  Environment,
  Lock,
  Mode,
  ModeSource,
  Space,
} from "@twigo/protocol";
import type { Lookup } from "../contextkey/when";
import type { Catalog } from "./catalog";

export const MODES: readonly Mode[] = ["read-write", "guarded", "read-only"];

export const ENVIRONMENTS: readonly Environment[] = [
  "production",
  "staging",
  "development",
  "local",
];

const MODE_LABEL: Readonly<Record<Mode, string>> = {
  "read-write": "Read-write",
  guarded: "Guarded",
  "read-only": "Read-only",
};

const MODE_HELP: Readonly<Record<Mode, string>> = {
  "read-write":
    "Changes go through, with a confirmation for what cannot be undone.",
  guarded: "Every change and exec asks first.",
  "read-only": "Reads only: Twigo sends no change, and dry runs still work.",
};

const ENVIRONMENT_LABEL: Readonly<Record<Environment, string>> = {
  production: "Production",
  staging: "Staging",
  development: "Development",
  local: "Local",
};

const ENVIRONMENT_HELP: Readonly<Record<Environment, string>> = {
  production: "Twigo sends no change until you unlock it.",
  staging: "Every change and exec asks first.",
  development:
    "Changes go through, with a confirmation for what cannot be undone.",
  local: "Changes go through, with a confirmation for what cannot be undone.",
};

export const NOT_MARKED = "Not marked";

export function modeLabel(mode: Mode): string {
  return MODE_LABEL[mode];
}

export function environmentLabel(environment: Environment): string {
  return ENVIRONMENT_LABEL[environment];
}

/** What a type gives a context by default, for the person choosing it. */
export function environmentHelp(environment: Environment): string {
  return ENVIRONMENT_HELP[environment];
}

/** What a mode lets through, for the person choosing it. */
export function modeHelp(mode: Mode): string {
  return MODE_HELP[mode];
}

/** The mode a press or a pick of the same leaves as it is, none for a context nobody marked, whose `guarded` is nobody's choice, so each mode plans. */
export function currentMode(access: ContextAccess): Mode | undefined {
  return access.source.kind === "unmarked" ? undefined : access.mode;
}

/** A space with one context has its access; one with several, none (ARCHITECTURE 4.2). */
export function accessOfSpace(
  catalog: Catalog,
  space: Space,
): ContextAccess | undefined {
  const [only, ...more] = space.contexts;
  return only === undefined || more.length > 0
    ? undefined
    : catalog.find(only)?.access;
}

/**
 * The chip's words, `Production · read-only`. A Production context says
 * read-write too, since that is the one to notice; other types leave it out,
 * and a context with no type says it when somebody chose it, a kubeconfig's
 * lock overridden among them, and that nobody did.
 */
export function chipLabel(access: ContextAccess): string {
  const { environment, mode, source, unlockedUntil } = access;
  const type = environment === null ? undefined : environmentLabel(environment);
  if (unlockedUntil !== null) {
    return type === undefined ? "Unlocked" : `${type} · unlocked`;
  }
  if (type === undefined) {
    if (source.kind !== "unmarked") return modeLabel(mode);
    return NOT_MARKED;
  }
  return mode === "read-write" && environment !== "production"
    ? type
    : `${type} · ${mode}`;
}

/**
 * What a lock says of a context: shut while its mode holds writes back, open
 * while an unlock lifts that, none for a context that lets them through,
 * guarded ones included, which ask first and hold nothing back.
 */
export function lockOf(
  access: ContextAccess | undefined,
): "shut" | "open" | undefined {
  if (access === undefined) return undefined;
  if (access.unlockedUntil !== null) return "open";
  return access.mode === "read-only" ? "shut" : undefined;
}

/**
 * What the active space's context will answer a write or an exec while its
 * mode is read-only, as its keys say: `prod-eu is read-only`. A space of
 * several contexts has no one mode, so it says nothing, and the gate decides.
 */
export function modeLock(lookup: Lookup): string | undefined {
  const name = lookup("context.name");
  return lookup("context.readOnly") === true && typeof name === "string"
    ? `${name} is read-only`
    : undefined;
}

/**
 * Whether nothing in the UI changes the mode or lifts it: the admin's file
 * holds it, or the person's protection file cannot be read, which holds
 * every context read-only until Twigo restarts.
 */
export function unchangeable(source: ModeSource): boolean {
  return source.kind === "policyFile" || source.kind === "protectionUnreadable";
}

/** A lock a choice sets aside, in words. */
function describeLock({ mode, source }: Lock): string {
  switch (source.kind) {
    case "kubeconfig":
      return `its kubeconfig's ${mode}`;
    case "provider":
      return `its provider's ${mode}`;
    case "environment":
      return `the ${mode} default for ${environmentLabel(source.environment)}`;
  }
}

/** Which rule gives a context its mode, in words. */
export function describeSource(source: ModeSource): string {
  switch (source.kind) {
    case "policyFile":
      return source.pattern === null
        ? `${source.file} cannot be read${source.reason ? ` (${source.reason})` : ""}, so every context is read-only until an admin fixes it and Twigo restarts.`
        : `${source.pattern} in ${source.file} sets this. Twigo cannot change or unlock it.`;
    case "protectionUnreadable":
      return `${source.file}, which holds the modes and types you set, cannot be read (${source.reason}), so every context is read-only until you restore or remove it and Twigo restarts.`;
    case "user":
      return source.overrides === null
        ? "You set this."
        : `You set this, over ${describeLock(source.overrides)}.`;
    case "kubeconfig":
      return "twigo.readOnly in its kubeconfig sets this.";
    case "provider":
      return "Its provider sets this.";
    case "environment":
      return `The default for ${environmentLabel(source.environment)}.`;
    case "unmarked":
      return "Nobody has said what this context is, so it is guarded: its first change or exec asks you.";
    case "unlisted":
      return "No source lists this context now, so Twigo sends it no change.";
    case "moved":
      return "Its name means another cluster now, so what is still open on the old one sends no change.";
  }
}

/** Which rule gives a context its mode, and what an unlock changes of it. */
export function describeAccess({
  source,
  unlockedUntil,
}: ContextAccess): string {
  const rule = describeSource(source);
  return unlockedUntil === null
    ? rule
    : `You unlocked it for now; then it is read-only again. ${rule}`;
}

/** What is left of an unlock, as `14:32`. */
export function countdown(left: number): string {
  const seconds = Math.max(0, Math.ceil(left / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}:${String(seconds % 60).padStart(2, "0")}`;
}
