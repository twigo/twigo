import type { Access, Backend, Gvr } from "@twigo/protocol";
import { Changes } from "@twigo/workbench";

/** A capability of the list's own resource: `resource.capability.patch/scale`. */
const OWN = "resource.capability.";
/** A capability of any resource by kubectl's name: `capability.create.jobs.batch`. */
const NAMED = "capability.";

/** The prefixes of the capability keys (ARCHITECTURE 5.1). */
export const CAPABILITY_PREFIXES = [OWN, NAMED] as const;

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
    const checks = keys.flatMap((key) => {
      const access = accessOf(key, resource);
      return access ? [{ key, access }] : [];
    });
    const asked = JSON.stringify([space, namespace ?? null, checks]);
    const list = this.#lists.get(uri);
    if (list?.asked === asked && list.basis === basis) return;
    this.#lists.set(uri, { asked, basis, answers: list?.answers ?? {} });
    if (checks.length === 0) return;
    this.backend
      .invoke("access_review", {
        space,
        namespace: namespace ?? null,
        checks: checks.map(({ access }) => access),
      })
      .then((answers) => {
        const current = this.#lists.get(uri);
        if (current?.asked !== asked || current.basis !== basis) return;
        this.#lists.set(uri, {
          asked,
          basis,
          answers: Object.fromEntries(
            checks.map(({ key }, index) => [key, answers[index] ?? true]),
          ),
        });
        this.changes.emit();
      }, this.report);
  }

  closed(uri: string): void {
    this.#lists.delete(uri);
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
