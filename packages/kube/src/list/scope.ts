import type { Parts } from "@twigo/protocol";
import type { Workbench } from "@twigo/workbench";
import type { ListInput } from "../uri";
import { leavesOut } from "./listStatus";

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

/** `whereWords`, unless the rows of some namespaces are left out of the list: then only the ones shown can be spoken of. */
export function shownWords(
  spaces: Workbench["spaces"],
  space: string,
  namespaces: readonly string[],
  parts: Parts,
): string {
  return leavesOut(parts)
    ? "the namespaces shown"
    : whereWords(spaces, space, namespaces);
}
