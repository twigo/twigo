import { useChanges, useWorkbench, type MenuId } from "@twigo/workbench";
import type { ActionGroups } from "@twigo/ui";
import { editLookup, type EditServices } from "./services";

export function useEditActions(
  edits: EditServices,
  uri: string,
  menus: readonly MenuId[],
): ActionGroups {
  const workbench = useWorkbench();
  useChanges(workbench.menus.changes);
  useChanges(workbench.commands.changes);
  useChanges(workbench.keybindings.changes);
  useChanges(edits.copies.changes);
  useChanges(edits.previews.changes);
  const lookup = editLookup(edits, uri, workbench.keys.lookup(null));
  return menus.flatMap((menu) => workbench.actions(menu, lookup, { uri }));
}
