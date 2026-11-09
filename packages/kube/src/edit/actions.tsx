import { ActionBar } from "@twigo/ui";
import type { MenuId } from "@twigo/workbench";
import type { EditServices } from "./services";
import { useEditActions } from "./useEditActions";

export function EditActions({
  edits,
  uri,
  menus,
}: {
  edits: EditServices;
  uri: string;
  menus: readonly MenuId[];
}) {
  const groups = useEditActions(edits, uri, menus);
  return groups.length === 0 ? null : <ActionBar inline actions={groups} />;
}
