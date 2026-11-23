import type { Backend } from "./backend";
import type {
  EventList,
  ObjectBatch,
  ObjectParts,
  ObjectQuery,
  Overview,
  Related,
  ViewState,
} from "./generated";
import { isShown, type ShownUsage } from "./metrics";
import { OpenView } from "./openView";

export interface ObjectSnapshot {
  readonly status: ViewState;
  /** False until the object is listed, and once it is deleted. */
  readonly exists: boolean;
  readonly overview: Overview | undefined;
  /** The object's JSON, managedFields dropped and a Secret's values replaced by their sizes. */
  readonly manifest: string | undefined;
  readonly events: EventList | undefined;
  readonly related: Related | undefined;
  /**
   * What a pod or a node uses, while the usage part is shown and the context
   * serves the Metrics API, with no figure while it `waits` for its first
   * answer; an `absent` usage withdraws it, until another comes.
   */
  readonly usage: ShownUsage | undefined;
}

export const INITIAL_OBJECT: ObjectSnapshot = {
  status: { state: "connecting" },
  exists: false,
  overview: undefined,
  manifest: undefined,
  events: undefined,
  related: undefined,
  usage: undefined,
};

/**
 * One open object, the drawer's or a resource editor's (ARCHITECTURE 4.3):
 * Rust follows only the parts its views show.
 */
export class ObjectView extends OpenView<
  ObjectParts,
  ObjectBatch,
  ObjectSnapshot
> {
  readonly #backend: Backend;

  constructor(backend: Backend, object: ObjectQuery, parts: ObjectParts) {
    super(
      {
        open: (onBatch) =>
          backend.subscribe("object_open", { object, parts }, onBatch),
        ask: (id, next) =>
          backend.invoke("object_set_parts", { id, parts: next }),
        ack: (id, seq) => backend.invoke("object_ack", { id, seq }),
        close: (id) => backend.invoke("object_close", id),
        what: "object",
      },
      INITIAL_OBJECT,
      parts,
    );
    this.#backend = backend;
  }

  /** The values of a ConfigMap's keys; null for a key it lacks or holds as binary data. */
  values(keys: readonly string[]): Promise<(string | null)[]> {
    return this.id().then((id) =>
      this.#backend.invoke("object_values", { id, keys: [...keys] }),
    );
  }

  protected next(batch: ObjectBatch, previous: ObjectSnapshot): ObjectSnapshot {
    return {
      status: batch.status,
      exists: batch.exists,
      overview: batch.exists
        ? (batch.overview ?? previous.overview)
        : undefined,
      manifest: batch.exists
        ? (batch.manifest ?? previous.manifest)
        : undefined,
      events: batch.events ?? previous.events,
      related: batch.related ?? previous.related,
      usage: usageAfter(batch, previous.usage),
    };
  }

  protected same(a: ObjectParts, b: ObjectParts): boolean {
    return sameParts(a, b);
  }
}

function usageAfter(
  batch: ObjectBatch,
  previous: ShownUsage | undefined,
): ShownUsage | undefined {
  if (!batch.exists) return undefined;
  if (batch.usage === null) return previous;
  return isShown(batch.usage) ? batch.usage : undefined;
}

function sameParts(a: ObjectParts, b: ObjectParts): boolean {
  return (
    a.overview === b.overview &&
    a.manifest === b.manifest &&
    a.events === b.events &&
    a.related === b.related &&
    a.usage === b.usage
  );
}
