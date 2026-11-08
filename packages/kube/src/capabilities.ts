import type { Access, Backend, Gvr } from "@twigo/protocol";
import { Changes } from "@twigo/workbench";

/** A capability of the list's own resource: `resource.capability.patch/scale`. */
const OWN = "resource.capability.";
/** A capability of any resource by kubectl's name: `capability.create.jobs.batch`. */
const NAMED = "capability.";

/** The prefixes of the capability keys (ARCHITECTURE 5.1). */
export const CAPABILITY_PREFIXES = [OWN, NAMED] as const;

/** Whether the person may delete a list's marked rows, wherever they are. */
export const MARKED_DELETE = "marked.capability.delete";
const DELETE = `${OWN}delete`;
/** Beside a list's own entry, the entry of its marked rows. */
const MARKED = "#marked";
/** How long a no holds before the list asks again, as Rust's `cluster::REFUSED_FOR`. */
export const REFUSED_MS = 30_000;

/** An object a list asks about: none of either for the resource as a whole. */
export interface Asked {
  /** None for a cluster-scoped object. */
  readonly namespace?: string;
  readonly name?: string;
}

/**
 * What RBAC lets the person do, as the `capability.*` context keys say it
 * (ARCHITECTURE 5.1), per list editor: each list asks Rust, which keeps
 * each SelfSubjectAccessReview with the context's clients, whenever what it
 * asks changes. A key reads true until an answer to what it asks now says
 * no, so only what the cluster refuses is disabled, and the server still
 * decides.
 */
export class Capabilities {
  readonly changes = new Changes();
  readonly #lists = new Map<
    string,
    {
      readonly asked: string;
      readonly basis: unknown;
      readonly answers: Readonly<Record<string, boolean>>;
    }
  >();

  constructor(
    private readonly backend: Pick<Backend, "invoke">,
    private readonly report: (error: unknown) => void,
  ) {}

  /** The keys' values for a list's selected object. */
  values(uri: string, keys: readonly string[]): Record<string, boolean> {
    const answers = this.#lists.get(uri)?.answers ?? {};
    return Object.fromEntries(keys.map((key) => [key, answers[key] ?? true]));
  }

  /**
   * Asks for the keys of a list's selected object of `resource`, unless
   * the list asked for the same on the same `basis` already: the contexts
   * as the catalog last listed them, which an edit of a kubeconfig, and so
   * a rebuild of the clients and of Rust's answers, lists anew. The keys of
   * the list's own resource name the object, as a rule that lists
   * `resourceNames` needs; the others are for their resource as a whole.
   */
  ask(
    uri: string,
    space: string,
    resource: Gvr,
    object: Asked,
    keys: readonly string[],
    basis: unknown,
  ): void {
    this.#ask(uri, space, resource, [object], keys, basis);
  }

  /**
   * Asks whether the person may delete a list's marked rows, each where it
   * is and by its name, as `ask` asks for the selected one: the marks, not
   * the selection, are what its Delete takes.
   */
  askMarked(
    uri: string,
    space: string,
    resource: Gvr,
    objects: readonly Asked[],
    basis: unknown,
  ): void {
    this.#ask(`${uri}${MARKED}`, space, resource, objects, [DELETE], basis);
  }

  /** `MARKED_DELETE` for a list. */
  marked(uri: string): boolean {
    return this.values(`${uri}${MARKED}`, [DELETE])[DELETE] ?? true;
  }

  /** One review a namespace; each key holds where every answer for it says yes. */
  #ask(
    entry: string,
    space: string,
    resource: Gvr,
    objects: readonly Asked[],
    keys: readonly string[],
    basis: unknown,
  ): void {
    const names = new Map<string | null, Set<string | null>>();
    for (const { namespace, name } of objects) {
      const where = names.get(namespace ?? null) ?? new Set();
      where.add(name ?? null);
      names.set(namespace ?? null, where);
    }
    const queries = [...names].map(([namespace, named]) => ({
      namespace,
      checks: [...named].flatMap((name) =>
        keys.flatMap((key) => {
          const access = accessOf(key, resource, name);
          return access ? [{ key, access }] : [];
        }),
      ),
    }));
    const asked = JSON.stringify([space, queries]);
    const list = this.#lists.get(entry);
    if (list?.asked === asked && list.basis === basis) return;
    this.#lists.set(entry, { asked, basis, answers: {} });
    if (list && Object.keys(list.answers).length > 0) this.changes.emit();
    const current = () => {
      const now = this.#lists.get(entry);
      return now?.asked === asked && now.basis === basis;
    };
    const asking = queries.filter(({ checks }) => checks.length > 0);
    if (asking.length === 0) return;
    const send = () => {
      Promise.all(
        asking.map(({ namespace, checks }) =>
          this.backend.invoke("access_review", {
            space,
            namespace,
            checks: checks.map(({ access }) => access),
          }),
        ),
      ).then(
        (answered) => {
          if (!current()) return;
          const answers: Record<string, boolean> = {};
          asking.forEach(({ checks }, at) => {
            checks.forEach(({ key }, index) => {
              const yes = answered[at]?.[index] ?? true;
              answers[key] = (answers[key] ?? true) && yes;
            });
          });
          this.#lists.set(entry, { asked, basis, answers });
          this.changes.emit();
          if (Object.values(answers).includes(false)) {
            setTimeout(() => {
              if (current()) send();
            }, REFUSED_MS);
          }
        },
        (error: unknown) => {
          this.report(error);
        },
      );
    };
    send();
  }

  closed(uri: string): void {
    this.#lists.delete(uri);
    this.#lists.delete(`${uri}${MARKED}`);
  }
}

/**
 * What a key asks of RBAC: `resource.capability.<verb>[/<subresource>]`
 * of the list's resource, for the object `name` if one, or
 * `capability.<verb>.<plural>[.<group>][/<subresource>]` of a resource by
 * kubectl's name, as a whole.
 */
export function accessOf(
  key: string,
  own: Gvr,
  name: string | null = null,
): Access | undefined {
  if (key.startsWith(OWN)) {
    const [verb, subresource] = key.slice(OWN.length).split("/");
    if (!verb) return undefined;
    return {
      verb,
      group: own.group,
      resource: own.resource,
      subresource: subresource ?? null,
      name,
    };
  }
  if (!key.startsWith(NAMED)) return undefined;
  const rest = key.slice(NAMED.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return undefined;
  const verb = rest.slice(0, dot);
  const [named, subresource] = rest.slice(dot + 1).split("/");
  if (!named) return undefined;
  const at = named.indexOf(".");
  return {
    verb,
    group: at < 0 ? "" : named.slice(at + 1),
    resource: at < 0 ? named : named.slice(0, at),
    subresource: subresource ?? null,
    name: null,
  };
}
