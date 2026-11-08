import type { ContextValue, Lookup, Workbench } from "@twigo/workbench";
import { WorkingCopies } from "./copies";
import { Previews } from "./previews";
import { Schemas } from "./schemas";

export interface EditServices {
  readonly copies: WorkingCopies;
  readonly schemas: Schemas;
  readonly previews: Previews;
}

export function createEdits(workbench: Workbench): EditServices {
  const copies = new WorkingCopies(
    workbench.state,
    workbench.editors,
    workbench.spaces.list.map(({ id }) => id),
  );
  workbench.editors.onClose((uri) => {
    copies.closed(uri);
  });
  return {
    copies,
    schemas: new Schemas(workbench.backend),
    previews: new Previews(workbench.backend),
  };
}

/**
 * What holds of an editor's edit, as context keys: the `when` of the
 * commands that act on it. The workbench sets them for its active editor,
 * and a bar looks its own editor's up.
 */
export function editKeys(
  { copies, previews }: Pick<EditServices, "copies" | "previews">,
  uri: string,
): Readonly<Record<string, ContextValue>> {
  const preview = previews.get(uri);
  const answer = preview?.state === "answered" ? preview.answer : undefined;
  return {
    "edit.object": uri.startsWith("k8s:"),
    "edit.new": uri.startsWith("untitled:"),
    "edit.dirty": copies.get(uri) !== undefined,
    "edit.serverChanged": copies.serverChanged(uri),
    "edit.answered": answer !== undefined,
    "edit.conflicts": answer?.state === "conflicts",
    "edit.ready": answer?.state === "ready",
    // A ready diff of the text as it is now: its plan sends exactly that.
    "edit.applicable":
      answer?.state === "ready" &&
      preview?.state === "answered" &&
      preview.subject.text === copies.get(uri)?.text,
    "edit.recreate": answer?.state === "immutable" && answer.recreate !== null,
  };
}

export const EDIT_KEYS: readonly string[] = [
  "edit.object",
  "edit.new",
  "edit.dirty",
  "edit.serverChanged",
  "edit.answered",
  "edit.conflicts",
  "edit.ready",
  "edit.applicable",
  "edit.recreate",
];

export function editLookup(
  edits: Pick<EditServices, "copies" | "previews">,
  uri: string,
  base: Lookup,
): Lookup {
  const keys = editKeys(edits, uri);
  return (key) => (key in keys ? keys[key] : base(key));
}
