/**
 * Pins what `apply_preview` answers to an edit that changes something, or
 * has an opened object change on its own: `?scenario=applyConflicts` and the
 * like. Any other scenario answers a changed edit as ready. `applyLate`
 * leaves an applied object after the plan is done, as a watch may deliver it.
 */
export type EditScenario =
  | "applyUnchanged"
  | "applyConflicts"
  | "applyStale"
  | "applyListsMoved"
  | "applyImmutable"
  | "applyRecreate"
  | "applyRemovals"
  | "applyMergePatch"
  | "serverChange"
  | "statusChange"
  | "applyLate";

export const EDIT_SCENARIOS: readonly EditScenario[] = [
  "applyUnchanged",
  "applyConflicts",
  "applyStale",
  "applyListsMoved",
  "applyImmutable",
  "applyRecreate",
  "applyRemovals",
  "applyMergePatch",
  "serverChange",
  "statusChange",
  "applyLate",
];

export function isEditScenario(scenario: string): scenario is EditScenario {
  return (EDIT_SCENARIOS as readonly string[]).includes(scenario);
}

/** The answer a scenario pins, by the name an edit's annotation gives it. */
export const PINNED_ANSWERS: Readonly<Partial<Record<EditScenario, string>>> = {
  applyUnchanged: "unchanged",
  applyConflicts: "conflicts",
  applyStale: "stale",
  applyListsMoved: "lists-moved",
  applyImmutable: "immutable",
  applyRecreate: "recreate",
  applyRemovals: "removals",
  applyMergePatch: "merge-patch",
};

type Fields = Record<string, unknown>;

/** How long an open object waits before it changes on its own, then between changes. */
export const FIRST_CHANGE_MS = 4000;
export const NEXT_CHANGE_MS = 12_000;

/** How long after its plan is done `applyLate` leaves an applied object. */
export const APPLIED_LAG_MS = 1500;

/**
 * The objects the mock's edits left, by what names them, so that an object
 * opened again after an apply, or a change from outside, shows them: the
 * recorded object stands in for any other. A write bumps the
 * `resourceVersion`.
 */
export class MockEdits {
  readonly #objects = new Map<string, Fields>();
  readonly #watchers = new Map<string, Set<() => void>>();
  #version = 5000;

  /** What names an object. */
  static key(
    context: string,
    group: string,
    resource: string,
    namespace: string | null,
    name: string,
  ): string {
    return JSON.stringify([context, group, resource, namespace, name]);
  }

  get(key: string): Fields | undefined {
    return this.#objects.get(key);
  }

  /** Follows a key's object, which `put` resends. */
  watch(key: string, onChange: () => void): () => void {
    const watchers = this.#watchers.get(key) ?? new Set();
    watchers.add(onChange);
    this.#watchers.set(key, watchers);
    return () => watchers.delete(onChange);
  }

  /**
   * Leaves `object` as the object, a Secret's values masked as Rust masks
   * them, with a new `resourceVersion`.
   */
  put(key: string, object: Fields): Fields {
    const masks = masked(object);
    const written = {
      ...masks,
      metadata: {
        ...(masks.metadata as Fields),
        resourceVersion: String(++this.#version),
      },
    };
    this.#objects.set(key, written);
    for (const onChange of this.#watchers.get(key) ?? []) onChange();
    return written;
  }
}

/** A Secret's values replaced by their sizes, those that are masks already left alone. */
export function masked(object: Fields): Fields {
  if (object.kind !== "Secret") return object;
  const mask = (values: unknown) =>
    typeof values === "object" && values !== null
      ? Object.fromEntries(
          Object.entries(values).map(([key, value]) => [
            key,
            typeof value === "string" && !/^<\d+ bytes>$/.test(value)
              ? `<${String(value.length)} bytes>`
              : value,
          ]),
        )
      : values;
  const { data, stringData, ...rest } = object;
  return {
    ...rest,
    ...(data !== undefined && { data: mask(data) }),
    ...(stringData !== undefined && { stringData: mask(stringData) }),
  };
}

/** An object as a side of the diff, as Rust's `side`: without what would only be noise. */
export function side(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const object = masked(value as Fields);
  const { metadata } = object as { metadata?: object };
  if (metadata === undefined) return object;
  return {
    ...object,
    metadata: Object.fromEntries(
      Object.entries(metadata).filter(
        ([name]) => name !== "resourceVersion" && name !== "generation",
      ),
    ),
  };
}
