import {
  accessOfSpace,
  setByPolicyFile,
  type ContextValue,
  type Lookup,
  type Workbench,
} from "@twigo/workbench";
import { WorkingCopies } from "./copies";
import { parseDiffUri, parseObjectUri } from "../uri";
import { Previews } from "./previews";
import { Schemas } from "./schemas";

export interface EditServices {
  readonly copies: WorkingCopies;
  readonly schemas: Schemas;
  readonly previews: Previews;
  /** Whether the space's context is read-only by an admin's policy file, which nothing in Twigo lifts. */
  lockedByPolicy(space: string): boolean;
}

export function createEdits(workbench: Workbench): EditServices {
  const copies = new WorkingCopies(
    workbench.state,
    workbench.editors,
    workbench.spaces,
  );
  workbench.editors.onClose((uri) => {
    copies.closed(uri);
  });
  return {
    copies,
    schemas: new Schemas(workbench.backend),
    previews: new Previews(workbench.backend),
    lockedByPolicy: (id) => {
      const space = workbench.spaces.list.find(
        (candidate) => candidate.id === id,
      );
      const access = space && accessOfSpace(workbench.catalog, space);
      return access?.mode === "read-only" && setByPolicyFile(access.source);
    },
  };
}

export type EditKeys = Pick<
  EditServices,
  "copies" | "previews" | "lockedByPolicy"
>;

/**
 * What holds of an editor's edit, as context keys: the `when` of the
 * commands that act on it. The workbench sets them for its active editor,
 * and a bar looks its own editor's up.
 */
export function editKeys(
  { copies, previews, lockedByPolicy }: EditKeys,
  uri: string,
): Readonly<Record<string, ContextValue>> {
  const preview = previews.get(uri);
  const answer = preview?.state === "answered" ? preview.answer : undefined;
  const refused =
    preview?.state === "answered" && lockedByPolicy(preview.subject.space);
  const planning = preview?.state === "answered" && preview.planning;
  return {
    "edit.object": uri.startsWith("k8s:"),
    "edit.new": uri.startsWith("untitled:"),
    "edit.dirty": copies.get(uri) !== undefined,
    "edit.answered": answer !== undefined,
    "edit.conflicts": answer?.state === "conflicts",
    "edit.keepable": answer?.state !== "stale" || answer.keepable,
    "edit.ready": answer?.state === "ready",
    // A ready diff that no tab was opened for, because its editor was not shown when it came.
    "edit.unshown":
      answer?.state === "ready" && preview?.state === "answered"
        ? !preview.shown
        : false,
    // Where no unlock can lift the lock, the plan could only fail.
    "edit.policyLocked": refused,
    // A ready diff that was shown, of the text as it is now: its plan sends exactly that, and the engine plans a preview once.
    "edit.applicable":
      answer?.state === "ready" &&
      preview?.state === "answered" &&
      preview.shown &&
      preview.subject.text === copies.get(uri)?.text &&
      !planning &&
      !refused,
    "edit.recreate":
      answer?.state === "immutable" &&
      answer.recreate !== null &&
      !planning &&
      !refused,
  };
}

/**
 * The space an editor belongs to: an object's is its URI's, a new manifest's
 * is where it was written, and the editor of a manifest without text yet
 * belongs to whichever shows it.
 */
export function editorSpace(
  { copies }: Pick<EditServices, "copies">,
  uri: string,
): string | undefined {
  return parseObjectUri(uri)?.space ?? copies.get(uri)?.space;
}

/**
 * The editor whose edit an editor is about: a diff of an apply or of the
 * server's object is of the editor it follows, anything else is its own.
 */
export function sourceOf(uri: string): string {
  const diff = parseDiffUri(uri);
  return diff && diff.kind !== "objects" ? diff.editor : uri;
}

export const EDIT_KEYS: readonly string[] = [
  "edit.object",
  "edit.new",
  "edit.dirty",
  "edit.answered",
  "edit.conflicts",
  "edit.keepable",
  "edit.ready",
  "edit.unshown",
  "edit.policyLocked",
  "edit.applicable",
  "edit.recreate",
];

export function editLookup(edits: EditKeys, uri: string, base: Lookup): Lookup {
  const keys = editKeys(edits, uri);
  return (key) => (key in keys ? keys[key] : base(key));
}
