import { IpcError } from "../error";
import type {
  Context,
  ContextAccess,
  Environment,
  Lock,
  LockSource,
  Mode,
  ModeSource,
} from "../generated";
import {
  CHOSEN,
  CONTEXTS,
  KUBECONFIG_READ_ONLY,
  KUBECONFIG_TYPES,
  MARKED,
} from "./fixtures";

const UNLOCK_MS = 15 * 60 * 1000;
const POLICY_FILE = "/Library/Application Support/Twigo/policy.json";
const POLICY_PATTERN = "prod-*";

const DEFAULT_MODE: Readonly<Record<Environment, Mode>> = {
  production: "read-only",
  staging: "guarded",
  development: "read-write",
  local: "read-write",
};

/** How much a mode holds back, as `twigo_policy::Mode`'s order does. */
export const STRICTNESS: Readonly<Record<Mode, number>> = {
  "read-write": 0,
  guarded: 1,
  "read-only": 2,
};

/** A change of what the person marked, or an unlock, to see what a context would be. */
export type Change =
  | { readonly mode: Mode | null }
  | { readonly environment: Environment | null }
  | { readonly unlock: true };

/** A lock that a person's type outlives, as `twigo_policy::Outlived` says. */
export type Outlived =
  | { readonly kind: "policyFile"; readonly file: string }
  | { readonly kind: "kubeconfig" };

/** What `twigo-policy` keeps for each context, over the fixtures' kubeconfig marks. */
export class MockAccess {
  readonly #watchers = new Set<(contexts: Context[]) => void>();
  readonly #modes = new Map<string, Mode>(Object.entries(CHOSEN));
  readonly #environments = new Map<string, Environment | null>(
    Object.entries(MARKED),
  );
  readonly #unlocks = new Map<string, number>();
  /** Contexts a policy file turned read-only after the app started. */
  readonly #filed = new Set<string>();

  constructor(private readonly policyFile: boolean) {}

  watch(onMessage: (contexts: Context[]) => void): Context[] {
    this.#watchers.add(onMessage);
    return this.#list();
  }

  setMode(name: string, mode: Mode | null): void {
    this.refuse(name);
    this.#unlocks.delete(name);
    if (mode === null) this.#modes.delete(name);
    else this.#modes.set(name, mode);
    this.#emit();
  }

  setEnvironment(name: string, environment: Environment | null): void {
    fixture(name);
    this.#unlocks.delete(name);
    this.#environments.set(name, environment);
    this.#emit();
  }

  unlock(name: string): void {
    this.refuse(name);
    const { mode, unlockedUntil } = this.of(name);
    if (mode !== "read-only" && unlockedUntil === null) {
      throw new IpcError(
        "invalidInput",
        `${name} is ${mode}, so there is nothing to unlock`,
      );
    }
    this.#unlocks.set(name, Date.now() + UNLOCK_MS);
    setTimeout(() => {
      this.#emit();
    }, UNLOCK_MS + 1);
    this.#emit();
  }

  relock(name: string): void {
    if (this.#unlocks.delete(name)) this.#emit();
  }

  /** An admin's policy file makes a running context read-only, which nothing in the app can change or unlock. */
  lockByFile(name: string): void {
    fixture(name);
    this.#filed.add(name);
    this.#unlocks.delete(name);
    this.#emit();
  }

  liftFile(name: string): void {
    fixture(name);
    this.#filed.delete(name);
    this.#emit();
  }

  /** What a context lets through now. */
  of(name: string): ContextAccess {
    return this.#access(fixture(name));
  }

  /** What a context would let through once `change` is made, an unlock it does not make ended. */
  would(name: string, change: Change): ContextAccess {
    return this.#access(fixture(name), change);
  }

  /**
   * What a context would let through with no lock but its type, now or once
   * `change` is made: no admin's policy file and no kubeconfig `readOnly`,
   * the person's own mode as it stands. A type outlives every lock.
   */
  bare(name: string, change?: Change): ContextAccess {
    return this.#access(fixture(name), change, false);
  }

  /** The locks that hold a context, which its type outlives: the policy file, then its kubeconfig's `readOnly`. */
  locks(name: string): Outlived[] {
    fixture(name);
    return [
      ...(this.#policyFileSets(name)
        ? [{ kind: "policyFile" as const, file: POLICY_FILE }]
        : []),
      ...(KUBECONFIG_READ_ONLY.has(name)
        ? [{ kind: "kubeconfig" as const }]
        : []),
    ];
  }

  /** Refuses what a policy file holds, as the gate does a change of its contexts' mode. */
  refuse(name: string): void {
    fixture(name);
    if (this.#policyFileSets(name)) {
      throw new IpcError(
        "permissions",
        `${this.#pattern(name)} in ${POLICY_FILE} sets this context's mode, which Twigo cannot change`,
      );
    }
  }

  #list(): Context[] {
    return CONTEXTS.map((context) => ({
      ...context,
      access: this.#access(context),
    }));
  }

  #emit(): void {
    const contexts = this.#list();
    for (const watcher of this.#watchers) watcher(contexts);
  }

  #access(context: Context, change?: Change, locked = true): ContextAccess {
    const { name } = context;
    const marked =
      change && "environment" in change
        ? change.environment
        : this.#environments.get(name);
    const environment =
      marked === undefined ? (KUBECONFIG_TYPES[name] ?? null) : marked;
    const chosen =
      change && "mode" in change
        ? (change.mode ?? undefined)
        : this.#modes.get(name);
    const { mode, source } = this.#resolve(name, environment, chosen, locked);
    const until =
      change === undefined
        ? this.#unlocks.get(name)
        : "unlock" in change
          ? Date.now() + UNLOCK_MS
          : undefined;
    const unlocked =
      until !== undefined &&
      until > Date.now() &&
      mode === "read-only" &&
      source.kind !== "policyFile";
    return {
      mode: unlocked ? "guarded" : mode,
      source,
      environment,
      unlockedUntil: unlocked ? until : null,
    };
  }

  /** As ARCHITECTURE 6.4 orders them: the policy file, the person's choice over the strictest lock, the strictest lock, else unmarked. */
  #resolve(
    name: string,
    environment: Environment | null,
    chosen: Mode | undefined,
    locked: boolean,
  ): { mode: Mode; source: ModeSource } {
    if (locked && this.#policyFileSets(name)) {
      return {
        mode: "read-only",
        source: {
          kind: "policyFile",
          file: POLICY_FILE,
          pattern: this.#pattern(name),
        },
      };
    }
    const lock = strictest(name, environment, locked);
    if (chosen) {
      const overrides =
        lock && STRICTNESS[lock.mode] > STRICTNESS[chosen] ? lock : null;
      return { mode: chosen, source: { kind: "user", overrides } };
    }
    if (lock) return { mode: lock.mode, source: lock.source };
    return { mode: "guarded", source: { kind: "unmarked" } };
  }

  #policyFileSets(name: string): boolean {
    return (
      (this.policyFile && name.startsWith("prod-")) || this.#filed.has(name)
    );
  }

  #pattern(name: string): string {
    return this.#filed.has(name) ? name : POLICY_PATTERN;
  }
}

/** The strictest of a context's locks, the kubeconfig's before the type's where they tie; the type's alone where `locked` is false. */
function strictest(
  name: string,
  environment: Environment | null,
  locked: boolean,
): Lock | undefined {
  const locks: Lock[] = [
    ...(locked && KUBECONFIG_READ_ONLY.has(name)
      ? [
          {
            mode: "read-only" as const,
            source: { kind: "kubeconfig" } as const,
          },
        ]
      : []),
    ...(environment
      ? [
          {
            mode: DEFAULT_MODE[environment],
            source: { kind: "environment", environment } as LockSource,
          },
        ]
      : []),
  ];
  return locks.reduce<Lock | undefined>(
    (best, lock) =>
      best === undefined || STRICTNESS[lock.mode] > STRICTNESS[best.mode]
        ? lock
        : best,
    undefined,
  );
}

function fixture(name: string): Context {
  const context = CONTEXTS.find((candidate) => candidate.name === name);
  if (!context) {
    throw new IpcError("notFound", `no source lists the context ${name}`);
  }
  return context;
}
