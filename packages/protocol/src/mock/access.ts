import { IpcError } from "../error";
import type {
  Catalog,
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
const PROTECTION_FILE =
  "/Users/you/Library/Application Support/io.twigo.ide/protection.json";
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

/** A lock that can go while the person's mode and type stay, as `twigo_policy::Outlived` says. */
export type Outlived =
  | { readonly kind: "policyFile"; readonly file: string }
  | { readonly kind: "kubeconfig" }
  | { readonly kind: "type" };

/** What the kubeconfigs say of each context, where it locks: `twigo.readOnly`, and `twigo.environment` where it is Production or Staging. */
export interface Kubeconfigs {
  readonly readOnly: ReadonlySet<string>;
  readonly types: Readonly<Record<string, Environment>>;
}

/** The person's protection file that Twigo could not read as it started: why, and what a look at it finds now, after the person left it, restored it or removed it by hand. */
export interface UnreadProtection {
  readonly reason: string;
  readonly now: "unreadable" | "restored" | "removed";
}

/** What `twigo-policy` keeps for each context, over the fixtures' kubeconfig marks. */
export class MockAccess {
  readonly #watchers = new Set<(catalog: Catalog) => void>();
  readonly #modes: Map<string, Mode>;
  readonly #environments: Map<string, Environment | null>;
  readonly #unlocks = new Map<string, number>();
  /** How many times a choice or an unlock changed what a context lets through, as `Policy::changes_of` counts. */
  readonly #changed = new Map<string, number>();
  /** Contexts a policy file turned read-only after the app started. */
  readonly #filed = new Set<string>();
  /** The person's protection file that could not be read, until they start over. */
  #protectionUnreadable: UnreadProtection | undefined;
  readonly #startedOver = new Set<() => void>();

  constructor(
    private readonly policyFile: boolean,
    private readonly kubeconfigs: Kubeconfigs = {
      readOnly: KUBECONFIG_READ_ONLY,
      types: KUBECONFIG_TYPES,
    },
    private readonly listed: Catalog = { contexts: CONTEXTS, failures: [] },
    /** Why the admin's policy file cannot be read, which makes every context read-only. */
    private readonly unreadable?: string,
    /** The person's protection file that cannot be read, which holds none of their choices, makes every context read-only below a policy file's entry and refuses every change until the person starts over. */
    protectionUnreadable?: UnreadProtection,
  ) {
    this.#protectionUnreadable = protectionUnreadable;
    const read = protectionUnreadable === undefined;
    this.#modes = new Map(read ? Object.entries(CHOSEN) : []);
    this.#environments = new Map(read ? Object.entries(MARKED) : []);
  }

  watch(onMessage: (catalog: Catalog) => void): Catalog {
    this.#watchers.add(onMessage);
    return this.#catalog();
  }

  setMode(name: string, mode: Mode | null): void {
    this.refuse(name);
    this.#unlocks.delete(name);
    if (mode === null) this.#modes.delete(name);
    else this.#modes.set(name, mode);
    this.#changes(name);
    this.#emit();
  }

  setEnvironment(name: string, environment: Environment | null): void {
    this.#fixture(name);
    this.refuseUnreadable();
    this.#unlocks.delete(name);
    this.#environments.set(name, environment);
    this.#changes(name);
    this.#emit();
  }

  unlock(name: string): void {
    this.refuse(name);
    const { mode, unlockedUntil } = this.of(name);
    if (mode !== "read-only" && unlockedUntil === null) {
      throw new IpcError(
        "policy.not-locked",
        `${name} is ${mode}, so there is nothing to unlock`,
      );
    }
    this.#unlocks.set(name, Date.now() + UNLOCK_MS);
    this.#changes(name);
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
    this.#fixture(name);
    this.#filed.add(name);
    this.#unlocks.delete(name);
    this.#emit();
  }

  liftFile(name: string): void {
    this.#fixture(name);
    this.#filed.delete(name);
    this.#emit();
  }

  /** What a context lets through now. */
  of(name: string): ContextAccess {
    return this.#access(this.#fixture(name));
  }

  /** What a context would let through once `change` is made, an unlock it does not make ended. */
  would(name: string, change: Change): ContextAccess {
    return this.#access(this.#fixture(name), change);
  }

  /**
   * What a context would let through with the locks `gone` taken away, now
   * or once `change` is made, the person's own mode and type kept.
   */
  without(
    name: string,
    gone: readonly Outlived[],
    change?: Change,
  ): ContextAccess {
    return this.#access(this.#fixture(name), change, gone);
  }

  /** How many times a choice or an unlock changed what a context lets through: a plan holds only while this stays. */
  changes(name: string): number {
    return this.#changed.get(name) ?? 0;
  }

  /** The locks that hold a context and can go: the policy file, its kubeconfig's `readOnly`, then its kubeconfig's type. The mock has no provider's lock. */
  locks(name: string): Outlived[] {
    this.#fixture(name);
    return [
      ...(this.#policyFileSets(name)
        ? [{ kind: "policyFile" as const, file: POLICY_FILE }]
        : []),
      ...(this.kubeconfigs.readOnly.has(name)
        ? [{ kind: "kubeconfig" as const }]
        : []),
      ...(this.kubeconfigs.types[name] !== undefined
        ? [{ kind: "type" as const }]
        : []),
    ];
  }

  /** Refuses what a policy file holds, as the gate does a change of its contexts' mode, and every change while the person's protection file cannot be read. */
  refuse(name: string): void {
    this.#fixture(name);
    if (this.unreadable !== undefined) {
      throw new IpcError(
        "policy.file-unreadable",
        `${POLICY_FILE} cannot be read, so every context is read-only`,
      );
    }
    if (this.#policyFileSets(name)) {
      throw new IpcError(
        "policy.file-sets-mode",
        `${this.#pattern(name)} in ${POLICY_FILE} sets this context's mode, which Twigo cannot change`,
      );
    }
    this.refuseUnreadable();
  }

  /** Refuses any change of protection while the person's protection file cannot be read, as `Policy::refuse_unreadable` does, so nothing writes over it. */
  refuseUnreadable(): void {
    if (this.#protectionUnreadable !== undefined) {
      throw new IpcError(
        "protection.unreadable",
        `${PROTECTION_FILE} cannot be read, so Twigo keeps read-only every context the policy file sets no mode for, and changes none`,
      );
    }
  }

  /** What a start over from the person's protection file would do now, as `Policy::plan_start_over` looks at the file again: refused while the policy reads it and where it reads by now, and nothing moves where it is gone. */
  startingOver(): { file: string; reason: string; aside: string | null } {
    const unread = this.#protectionUnreadable;
    if (unread === undefined) {
      throw new IpcError(
        "protection.readable",
        `${PROTECTION_FILE} can be read, or is not there, so there is nothing to start over from`,
      );
    }
    if (unread.now === "restored") {
      throw new IpcError(
        "protection.restored",
        `${PROTECTION_FILE} can be read now, which Twigo takes from its next start, so it did not start over`,
      );
    }
    return {
      file: PROTECTION_FILE,
      reason: unread.reason,
      aside: unread.now === "removed" ? null : `${PROTECTION_FILE}.unreadable`,
    };
  }

  /** Starts over as `Policy::start_over` does: no choice holds, nothing reads closed, and each listener of `onStartOver` hears it. */
  startOver(): void {
    this.startingOver();
    this.#protectionUnreadable = undefined;
    this.#emit();
    for (const listener of this.#startedOver) listener();
  }

  /** Whether the person's protection file reads now. */
  get protectionReads(): boolean {
    return this.#protectionUnreadable === undefined;
  }

  onStartOver(listener: () => void): void {
    this.#startedOver.add(listener);
  }

  #changes(name: string): void {
    this.#changed.set(name, (this.#changed.get(name) ?? 0) + 1);
  }

  has(name: string): boolean {
    return this.listed.contexts.some((context) => context.name === name);
  }

  #fixture(name: string): Context {
    const context = this.listed.contexts.find(
      (candidate) => candidate.name === name,
    );
    if (!context) {
      throw new IpcError(
        "context.not-listed",
        `no source lists the context ${name}`,
      );
    }
    return context;
  }

  #list(): Context[] {
    return this.listed.contexts.map((context) => ({
      ...context,
      access: this.#access(context),
    }));
  }

  #catalog(): Catalog {
    return { contexts: this.#list(), failures: [...this.listed.failures] };
  }

  #emit(): void {
    const catalog = this.#catalog();
    for (const watcher of this.#watchers) watcher(catalog);
  }

  #access(
    context: Context,
    change?: Change,
    gone: readonly Outlived[] = [],
  ): ContextAccess {
    const { name } = context;
    const marked =
      change && "environment" in change
        ? change.environment
        : this.#environments.get(name);
    const environment =
      marked === undefined
        ? gone.some(({ kind }) => kind === "type")
          ? null
          : (this.kubeconfigs.types[name] ?? null)
        : marked;
    const chosen =
      change && "mode" in change
        ? (change.mode ?? undefined)
        : this.#modes.get(name);
    const { mode, source } = this.#resolve(name, environment, chosen, gone);
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

  /** As ARCHITECTURE 6.4 orders them: the policy file, the person's protection file that cannot be read, the person's choice over the strictest lock, the strictest lock, else unmarked. */
  #resolve(
    name: string,
    environment: Environment | null,
    chosen: Mode | undefined,
    gone: readonly Outlived[],
  ): { mode: Mode; source: ModeSource } {
    const lacks = (lock: Outlived["kind"]) =>
      gone.some(({ kind }) => kind === lock);
    if (this.unreadable !== undefined) {
      return {
        mode: "read-only",
        source: {
          kind: "policyFile",
          file: POLICY_FILE,
          pattern: null,
          reason: this.unreadable,
        },
      };
    }
    if (!lacks("policyFile") && this.#policyFileSets(name)) {
      return {
        mode: "read-only",
        source: {
          kind: "policyFile",
          file: POLICY_FILE,
          pattern: this.#pattern(name),
        },
      };
    }
    if (this.#protectionUnreadable !== undefined) {
      return {
        mode: "read-only",
        source: {
          kind: "protectionUnreadable",
          file: PROTECTION_FILE,
          reason: this.#protectionUnreadable.reason,
        },
      };
    }
    const lock = strictest(
      environment,
      !lacks("kubeconfig") && this.kubeconfigs.readOnly.has(name),
    );
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

/** The strictest of a context's locks, the kubeconfig's `readOnly` before the type's where they tie. */
function strictest(
  environment: Environment | null,
  readOnly: boolean,
): Lock | undefined {
  const locks: Lock[] = [
    ...(readOnly
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
