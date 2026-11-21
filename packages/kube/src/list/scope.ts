import type { Parts } from "@twigo/protocol";
import type { Workbench } from "@twigo/workbench";
import type { ListInput } from "../uri";

/** The namespaces a list reads: its own when its URI names them, else its space's scope. */
export function namespacesOf(
  spaces: Workbench["spaces"],
  input: ListInput,
): readonly string[] {
  return input.namespaces ?? spaces.state(input.space).namespaces;
}

/**
 * Where a list looks, for the words of an empty one: the space's contexts,
 * then the namespaces it is narrowed to, `prod-eu · payments`.
 */
export function whereWords(
  spaces: Workbench["spaces"],
  space: string,
  namespaces: readonly string[],
): string {
  const contexts = spaces.get(space)?.contexts.join(" + ") ?? space;
  return [
    contexts,
    ...(namespaces.length > 0 ? [namespaces.join(", ")] : []),
  ].join(" · ");
}

export const namespaceWords = (count: number): string =>
  `${String(count)} ${count === 1 ? "namespace" : "namespaces"}`;

/** Where a list of every namespace looks when the credentials may list the kind in some only; none when it leaves none out. */
export function mayListWords({ count, omitted }: Parts): string | undefined {
  return omitted > 0 ? `the ${namespaceWords(count)} you may list` : undefined;
}
