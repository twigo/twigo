import type { ListQuery, Part, Parts, ViewState } from "../generated";
import { leastReady, REFUSED, SHOWS_ROWS } from "../viewState";
import { NAMESPACES as CLUSTER_NAMESPACES } from "./fixtures";

/** States in which Rust knows the server's columns: from a list's first page on. */
const KNOWS_COLUMNS = new Set<ViewState["state"]>([
  "syncing",
  "ready",
  "relisting",
  "stale",
]);

/** More namespaces than the hub's `NAMESPACES` are read cluster-wide, by a person who may list the kind there. */
const NAMESPACES = 4;

/** The namespaces where a scenario's person may list pods. */
const BOUND: Readonly<Record<string, readonly string[]>> = {
  rbacNamespaces: ["default"],
  rbacTypedNamespaces: ["default", "payments"],
};

/**
 * The namespaces that "All namespaces" resolves to for a person who may list
 * the namespaces and not the resource cluster-wide, as the hub resolves it
 * (ARCHITECTURE 3.2); none for a person who may do neither, whose "All
 * namespaces" the cluster refuses.
 */
function resolvedFor(scenario: string): readonly string[] | undefined {
  return scenario === "rbacNamespaces" ? BOUND[scenario] : undefined;
}

/** What a scenario makes of one part, whatever the list's own state is; none leaves the part to it. */
export type Pin = (
  part: Part,
  at: number,
  of: number,
) => { state: ViewState; shown: boolean } | undefined;

/**
 * The scenarios of a person whose rights reach some namespaces only: the hub
 * reads such a person's lists namespace by namespace, and a namespace they
 * lack is refused alone.
 */
export function pinOf(scenario: string, resource: string): Pin | undefined {
  const refused = {
    state: { state: "forbidden", verb: "watch", resource },
    shown: false,
  } as const;
  const bound = BOUND[scenario];
  if (bound) {
    return (part) =>
      part.kind === "namespace" && bound.includes(part.name)
        ? undefined
        : refused;
  }
  if (scenario === "partsQueued") {
    return (part, at, of) => {
      if (part.kind === "cluster") return refused;
      return of > 3 && at >= of - 2
        ? { state: { state: "queued" }, shown: at === of - 2 }
        : undefined;
    };
  }
  return undefined;
}

export interface PartsView {
  readonly status: ViewState;
  readonly parts: Parts;
  /** The namespaces whose rows the list shows; none is every one it reads. */
  readonly namespaces: readonly string[] | null;
  /** Some part has its first page, so Rust knows the columns. */
  readonly knows: boolean;
}

/** The parts of one list, which the hub keeps one upstream each for. */
export class MockParts {
  readonly #parts: readonly Part[];
  readonly #pin: Pin | undefined;
  /** The namespaces "All namespaces" resolved to, with every other one left out. */
  readonly #resolved: readonly string[] | undefined;

  constructor(query: ListQuery, scenario: string) {
    this.#pin = pinOf(scenario, query.gvr.resource);
    const names = [...new Set(query.namespaces)].sort();
    const resolved =
      query.namespaced && names.length === 0
        ? resolvedFor(scenario)
        : undefined;
    this.#resolved = resolved;
    const read = resolved ?? names;
    this.#parts =
      !query.namespaced ||
      read.length === 0 ||
      (this.#pin === undefined && read.length > NAMESPACES)
        ? [{ kind: "cluster" }]
        : read.map((name) => ({ kind: "namespace", name }));
  }

  /** The list while the parts a scenario leaves alone are in `state`. */
  at(state: ViewState): PartsView {
    const of = this.#parts.length;
    const placed = this.#parts.map((part, at) => ({
      part,
      ...(this.#pin?.(part, at, of) ?? {
        state:
          state.state === "syncing"
            ? {
                state: "syncing" as const,
                loaded: Math.round(state.loaded / of),
              }
            : state,
        shown: SHOWS_ROWS.has(state.state),
      }),
    }));
    const shown = placed.filter((part) => part.shown);
    const onTheirWay = placed.filter(({ state }) => !REFUSED.has(state.state));
    return {
      status:
        shown.length > 0
          ? leastReady(
              shown.map(({ state }) =>
                state.state === "queued" ? { state: "stale" } : state,
              ),
            )
          : leastReady(
              (onTheirWay.length > 0 ? onTheirWay : placed).map(
                ({ state }) => state,
              ),
            ),
      parts: {
        count: of,
        unready: placed.filter(({ state }) => state.state !== "ready"),
        omitted: this.#resolved
          ? CLUSTER_NAMESPACES.length - this.#resolved.length
          : 0,
      },
      namespaces:
        shown.length === of && !this.#resolved
          ? null
          : shown.flatMap(({ part }) =>
              part.kind === "namespace" ? [part.name] : [],
            ),
      knows: placed.some(
        ({ state, shown }) => shown || KNOWS_COLUMNS.has(state.state),
      ),
    };
  }
}
