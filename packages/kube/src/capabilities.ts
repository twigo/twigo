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

/**
 * What RBAC lets the person do, as the `capability.*` context keys say it
 * (ARCHITECTURE 5.1), per list editor: each list asks Rust, which keeps
 * each SelfSubjectAccessReview with the context's clients, whenever what it
 * asks changes, and keeps its last answers meanwhile. A key reads true
 * until an answer says no, so only what the cluster refuses is disabled,
 * and the server still decides.
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
   * Asks for the keys of a list's selected object of `resource` in
   * `namespace`, none for a cluster-scoped one, unless the list asked for
   * the same on the same `basis` already: the contexts as the catalog last
   * listed them, which an edit of a kubeconfig, and so a rebuild of the
   * clients and of Rust's answers, lists anew.
   */
  ask(
    uri: string,
    space: string,
    resource: Gvr,
    namespace: string | undefined,
    keys: readonly string[],
    basis: unknown,
  ): void {
    this.#ask(uri, space, resource, [namespace ?? null], keys, basis);
  }

  /**
   * Asks whether the person may delete a list's marked rows, in each
   * namespace they are in, as `ask` asks for the selected one: the marks,
   * not the selection, are what its Delete takes.
   */
  askMarked(
    uri: string,
    space: string,
    resource: Gvr,
    namespaces: readonly (string | undefined)[],
    basis: unknown,
  ): void {
    const where = [
      ...new Set(namespaces.map((namespace) => namespace ?? null)),
    ];
    this.#ask(`${uri}${MARKED}`, space, resource, where, [DELETE], basis);
  }

  /** `MARKED_DELETE` for a list. */
  marked(uri: string): boolean {
    return this.values(`${uri}${MARKED}`, [DELETE])[DELETE] ?? true;
  }

  /** Each key holds where every namespace's answer says yes. */
  #ask(
    entry: string,
    space: string,
    resource: Gvr,
    namespaces: readonly (string | null)[],
    keys: readonly string[],
    basis: unknown,
  ): void {
    const checks = keys.flatMap((key) => {
      const access = accessOf(key, resource);
      return access ? [{ key, access }] : [];
    });
    const asked = JSON.stringify([space, [...namespaces].sort(), checks]);
    const list = this.#lists.get(entry);
    if (list?.asked === asked && list.basis === basis) return;
    this.#lists.set(entry, { asked, basis, answers: list?.answers ?? {} });
    if (checks.length === 0 || namespaces.length === 0) return;
    Promise.all(
      namespaces.map((namespace) =>
        this.backend.invoke("access_review", {
          space,
          namespace,
          checks: checks.map(({ access }) => access),
        }),
      ),
    ).then((answered) => {
      const current = this.#lists.get(entry);
      if (current?.asked !== asked || current.basis !== basis) return;
      this.#lists.set(entry, {
        asked,
        basis,
        answers: Object.fromEntries(
          checks.map(({ key }, index) => [
            key,
            answered.every((answers) => answers[index] ?? true),
          ]),
        ),
      });
      this.changes.emit();
    }, this.report);
  }

  closed(uri: string): void {
    this.#lists.delete(uri);
    this.#lists.delete(`${uri}${MARKED}`);
  }
}

/**
 * What a key asks of RBAC: `resource.capability.<verb>[/<subresource>]`
 * of the list's resource, or `capability.<verb>.<plural>[.<group>][/<subresource>]`
 * of a resource by kubectl's name.
 */
export function accessOf(key: string, own: Gvr): Access | undefined {
  if (key.startsWith(OWN)) {
    const [verb, subresource] = key.slice(OWN.length).split("/");
    if (!verb) return undefined;
    return {
      verb,
      group: own.group,
      resource: own.resource,
      subresource: subresource ?? null,
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
  };
}
