import type {
  ContextAccess,
  Environment,
  Mode,
  ModeSource,
  Space,
} from "@twigo/protocol";
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

export function modeLabel(mode: Mode): string {
  return MODE_LABEL[mode];
}

export function environmentLabel(environment: Environment): string {
  return ENVIRONMENT_LABEL[environment];
}

/** What a mode lets through, for the person choosing it. */
export function modeHelp(mode: Mode): string {
  return MODE_HELP[mode];
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
 * The chip's words, `Production · read-only`, or none for a context nothing
 * says anything of. A Production context says read-write too, since that is
 * the one to notice; other types leave it out, and a context with no type says
 * it when somebody chose it, a kubeconfig's lock overridden among them.
 */
export function chipLabel(access: ContextAccess): string | undefined {
  const { environment, mode, source, unlockedUntil } = access;
  const type = environment === null ? undefined : environmentLabel(environment);
  if (unlockedUntil !== null) {
    return type === undefined ? "Unlocked" : `${type} · unlocked`;
  }
  if (type === undefined) {
    return source.kind === "default" ? undefined : modeLabel(mode);
  }
  return mode === "read-write" && environment !== "production"
    ? type
    : `${type} · ${mode}`;
}

/** Whether the admin's file holds the mode, so nothing in the UI changes it. */
export function setByPolicyFile(source: ModeSource): boolean {
  return source.kind === "policyFile";
}

/** Which rule gives a context its mode, in words. */
export function describeSource(source: ModeSource): string {
  switch (source.kind) {
    case "policyFile":
      return source.pattern === null
        ? `${source.file} cannot be read, so every context is read-only until an admin fixes it and Twigo restarts.`
        : `${source.pattern} in ${source.file} sets this. Twigo cannot change or unlock it.`;
    case "user":
      return "You set this.";
    case "kubeconfig":
      return "twigo.readOnly in its kubeconfig sets this.";
    case "provider":
      return "Its provider sets this.";
    case "environment":
      return `The default for ${environmentLabel(source.environment)}.`;
    case "default":
      return "Nothing limits this context.";
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
