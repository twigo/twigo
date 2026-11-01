import { useEffect, useState } from "react";
import type { Backend, Gvr, Resource } from "@twigo/protocol";

/** The resources each space serves, asked once per space. */
export class Discovery {
  readonly #spaces = new Map<string, Promise<readonly Resource[]>>();
  readonly #versions = new Map<string, Promise<string>>();

  constructor(private readonly backend: Backend) {}

  resources(space: string): Promise<readonly Resource[]> {
    let pending = this.#spaces.get(space);
    if (!pending) {
      pending = this.backend.invoke("resources_list", space);
      pending.catch(() => this.#spaces.delete(space));
      this.#spaces.set(space, pending);
    }
    return pending;
  }

  /** A context's Kubernetes version, asked once. */
  version(context: string): Promise<string> {
    let pending = this.#versions.get(context);
    if (!pending) {
      pending = this.backend
        .invoke("cluster_version", context)
        .then((version) => version.gitVersion);
      pending.catch(() => this.#versions.delete(context));
      this.#versions.set(context, pending);
    }
    return pending;
  }
}

export type Loaded<T> =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly value: T }
  | { readonly state: "failed"; readonly error: unknown };

export function useResources(
  discovery: Discovery,
  space: string,
): Loaded<readonly Resource[]> {
  const [loaded, setLoaded] = useState<{
    space: string;
    result: Loaded<readonly Resource[]>;
  }>();
  useEffect(() => {
    let live = true;
    discovery.resources(space).then(
      (value) => {
        if (live) setLoaded({ space, result: { state: "ready", value } });
      },
      (error: unknown) => {
        if (live) setLoaded({ space, result: { state: "failed", error } });
      },
    );
    return () => {
      live = false;
    };
  }, [discovery, space]);
  return loaded?.space === space ? loaded.result : { state: "loading" };
}

export function sameGvr(a: Gvr, b: Gvr): boolean {
  return (
    a.group === b.group && a.version === b.version && a.resource === b.resource
  );
}
