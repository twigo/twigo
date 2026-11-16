import type { Workbench } from "@twigo/workbench";
import type { ListInput } from "../uri";

/** The namespaces a list reads: its own when its URI names them, else its space's scope. */
export function namespacesOf(
  spaces: Workbench["spaces"],
  input: ListInput,
): readonly string[] {
  return input.namespaces ?? spaces.state(input.space).namespaces;
}

/** Back to every namespace of the space, which is what no scope means. */
export function showAllNamespaces(
  spaces: Workbench["spaces"],
  space: string,
): void {
  spaces.update(space, (state) => ({ ...state, namespaces: [] }));
}
