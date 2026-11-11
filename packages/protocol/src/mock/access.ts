import { IpcError } from "../error";
import type {
  Context,
  ContextAccess,
  Environment,
  Mode,
  ModeSource,
} from "../generated";
import { CONTEXTS } from "./fixtures";

const UNLOCK_MS = 15 * 60 * 1000;
const POLICY_FILE = "/Library/Application Support/Twigo/policy.json";
const POLICY_PATTERN = "prod-*";

const DEFAULT_MODE: Readonly<Record<Environment, Mode>> = {
  production: "read-only",
  staging: "guarded",
  development: "read-write",
  local: "read-write",
};

/** What `twigo-policy` keeps for each context, over the fixtures' kubeconfig marks. */
export class MockAccess {
  readonly #watchers = new Set<(contexts: Context[]) => void>();
  readonly #modes = new Map<string, Mode>();
  readonly #environments = new Map<string, Environment | null>();
  readonly #unlocks = new Map<string, number>();
  /** Contexts a policy file turned read-only after the app started. */
  readonly #filed = new Set<string>();

  constructor(private readonly policyFile: boolean) {}

  watch(onMessage: (contexts: Context[]) => void): Context[] {
    this.#watchers.add(onMessage);
    return this.#list();
  }

  setMode(name: string, mode: Mode | null): void {
    fixture(name);
    this.#refusePolicyFile(name);
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
    const context = fixture(name);
    this.#refusePolicyFile(name);
    const { mode, unlockedUntil } = this.#access(context);
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

  /** What a context lets through now. */
  of(name: string): ContextAccess {
    return this.#access(fixture(name));
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

  #access(context: Context): ContextAccess {
    const marked = this.#environments.get(context.name);
    const environment =
      marked === undefined ? context.access.environment : marked;
    const { mode, source } = this.#resolve(context.name, environment);
    const until = this.#unlocks.get(context.name);
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

  #resolve(
    name: string,
    environment: Environment | null,
  ): { mode: Mode; source: ModeSource } {
    if (this.#policyFileSets(name)) {
      return {
        mode: "read-only",
        source: {
          kind: "policyFile",
          file: POLICY_FILE,
          pattern: this.#pattern(name),
        },
      };
    }
    const chosen = this.#modes.get(name);
    if (chosen) return { mode: chosen, source: { kind: "user" } };
    if (environment) {
      return {
        mode: DEFAULT_MODE[environment],
        source: { kind: "environment", environment },
      };
    }
    return { mode: "read-write", source: { kind: "default" } };
  }

  #policyFileSets(name: string): boolean {
    return (
      (this.policyFile && name.startsWith("prod-")) || this.#filed.has(name)
    );
  }

  #refusePolicyFile(name: string): void {
    if (this.#policyFileSets(name)) {
      throw new IpcError(
        "permissions",
        `${this.#pattern(name)} in ${POLICY_FILE} sets this context's mode, which Twigo cannot change`,
      );
    }
  }

  #pattern(name: string): string {
    return this.#filed.has(name) ? name : POLICY_PATTERN;
  }
}

function fixture(name: string): Context {
  const context = CONTEXTS.find((candidate) => candidate.name === name);
  if (!context) {
    throw new IpcError("notFound", `no source lists the context ${name}`);
  }
  return context;
}
