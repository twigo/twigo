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
 * (ARCHITECTURE 5.1): each key one SelfSubjectAccessReview that Rust keeps
 * with the context's clients. A key reads true until its answer comes, so
 * only what the cluster refuses is disabled, and the server still decides.
 */
export class Capabilities {
  readonly changes = new Changes();
  /** Answers by space, namespace and key. */
  readonly #answers = new Map<string, boolean>();
  readonly #asked = new Set<string>();

  constructor(private readonly backend: Pick<Backend, "invoke">) {}

  /**
   * The keys' values for an object of `resource` in `namespace`, none for a
   * cluster-scoped one; asks for the ones not known yet.
   */
  values(
    space: string,
    resource: Gvr,
    namespace: string | undefined,
    keys: readonly string[],
  ): Record<string, boolean> {
    const values: Record<string, boolean> = {};
    const missing: { key: string; access: Access }[] = [];
    for (const key of keys) {
      const access = accessOf(key, resource);
      if (!access) continue;
      const id = `${space}\u0000${namespace ?? ""}\u0000${key}`;
      const answer = this.#answers.get(id);
      values[key] = answer ?? true;
      if (answer === undefined && !this.#asked.has(id)) {
        this.#asked.add(id);
        missing.push({ key: id, access });
      }
    }
    if (missing.length > 0) {
      this.backend
        .invoke("access_review", {
          space,
          namespace: namespace ?? null,
          checks: missing.map(({ access }) => access),
        })
        .then(
          (answers) => {
            missing.forEach(({ key }, index) => {
              this.#answers.set(key, answers[index] ?? true);
            });
            this.changes.emit();
          },
          () => {
            for (const { key } of missing) this.#asked.delete(key);
          },
        );
    }
    return values;
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
