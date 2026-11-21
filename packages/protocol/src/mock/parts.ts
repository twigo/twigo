import type { ListQuery, Part, Parts, ViewState } from "../generated";
import { leastReady, REFUSED, SHOWS_ROWS } from "../viewState";

/** States in which Rust knows the server's columns: from a list's first page on. */
const KNOWS_COLUMNS = new Set<ViewState["state"]>([
  "syncing",
  "ready",
  "relisting",
  "stale",
]);

/** More namespaces than the hub's `NAMESPACES` are read cluster-wide, by a person who may list the kind there. */
const NAMESPACES = 4;

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
  if (scenario === "rbacNamespaces") {
    return (part) =>
      part.kind === "namespace" && part.name === "default"
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

  constructor(query: ListQuery, pin: Pin | undefined) {
    this.#pin = pin;
    const names = [...new Set(query.namespaces)].sort();
    this.#parts =
      !query.namespaced ||
      names.length === 0 ||
      (pin === undefined && names.length > NAMESPACES)
        ? [{ kind: "cluster" }]
        : names.map((name) => ({ kind: "namespace", name }));
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
        omitted: 0,
      },
      namespaces:
        shown.length === of
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
