import {
  toIpcError,
  type Discovered,
  type Gvr,
  type IpcError,
  type Resource,
} from "@twigo/protocol";
import { Changes, useChanges, type Workbench } from "@twigo/workbench";

export type Loaded<T> =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly value: T }
  | { readonly state: "failed"; readonly error: IpcError };

/**
 * The resources of the active space, as Rust follows them (ARCHITECTURE
 * 3.6), and each context's version. A space shown before keeps its last
 * answer until it is followed again.
 */
export class Discovery {
  readonly changes = new Changes();
  readonly #spaces = new Map<string, Loaded<readonly Resource[]>>();
  readonly #versions = new Map<string, Promise<string>>();
  #space: string | undefined;
  #ready: number;
  /**
   * The last watch asked for, which the next waits on: Rust keeps one
   * follower per webview, that of the watch it answered last, at once.
   */
  #watching: Promise<void> = Promise.resolve();

  constructor(
    private readonly workbench: Pick<
      Workbench,
      "backend" | "spaces" | "catalog"
    > & {
      readonly credentials: Pick<Workbench["credentials"], "changes" | "ready">;
    },
  ) {
    this.#ready = workbench.credentials.ready;
    workbench.spaces.changes.subscribe(() => {
      this.#follow(workbench.spaces.active?.id);
    });
    // Rust stops following what the credential refused, as the hub stops
    // its upstreams, so the space is followed again once a credential
    // comes, whatever the last answer was, and once the kubeconfig
    // changes, which may have fixed it.
    workbench.credentials.changes.subscribe(() => {
      const { ready } = workbench.credentials;
      if (ready === this.#ready) return;
      this.#ready = ready;
      if (this.#space !== undefined) this.#watch(this.#space);
    });
    workbench.catalog.changes.subscribe(() => {
      if (this.#space !== undefined) this.#watch(this.#space);
    });
    this.#follow(workbench.spaces.active?.id);
  }

  get(space: string): Loaded<readonly Resource[]> {
    return this.#spaces.get(space) ?? { state: "loading" };
  }

  /** The space's resources once they come, or why they did not. */
  resources(space: string): Promise<readonly Resource[]> {
    return new Promise((resolve, reject) => {
      const settle = () => {
        const loaded = this.get(space);
        if (loaded.state === "loading") return;
        unsubscribe();
        if (loaded.state === "ready") resolve(loaded.value);
        else reject(loaded.error);
      };
      const unsubscribe = this.changes.subscribe(settle);
      settle();
    });
  }

  /** A context's Kubernetes version, asked once. */
  version(context: string): Promise<string> {
    let pending = this.#versions.get(context);
    if (!pending) {
      pending = this.workbench.backend
        .invoke("cluster_version", context)
        .then((version) => version.gitVersion);
      pending.catch(() => this.#versions.delete(context));
      this.#versions.set(context, pending);
    }
    return pending;
  }

  #follow(space: string | undefined): void {
    if (space === this.#space) return;
    this.#space = space;
    if (space !== undefined) this.#watch(space);
  }

  #watch(space: string): void {
    this.#watching = this.#watching.then(async () => {
      if (space !== this.#space) return;
      try {
        await this.workbench.backend.subscribe(
          "resources_watch",
          space,
          (next) => {
            this.#set(space, next);
          },
        );
      } catch (error: unknown) {
        this.#set(space, { state: "failed", error: toIpcError(error) });
      }
    });
  }

  #set(space: string, discovered: Discovered): void {
    this.#spaces.set(
      space,
      discovered.state === "ready"
        ? { state: "ready", value: discovered.resources }
        : { state: "failed", error: toIpcError(discovered.error) },
    );
    this.changes.emit();
  }
}

export function useResources(
  discovery: Discovery,
  space: string,
): Loaded<readonly Resource[]> {
  useChanges(discovery.changes);
  return discovery.get(space);
}

export function sameGvr(a: Gvr, b: Gvr): boolean {
  return (
    a.group === b.group && a.version === b.version && a.resource === b.resource
  );
}
