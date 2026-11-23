import type { ReactNode } from "react";
import { ActionBar } from "@twigo/ui";
import { useChanges, useWorkbench } from "@twigo/workbench";

/**
 * The bar over a release's text, as the YAML view's: what it says of the text
 * at the left, and at the right the commands that act on the whole of it,
 * where there is something to show or to hide.
 */
export function TextBar({
  uri,
  note,
  canReveal,
  canHide,
}: {
  /** The release page's, which the commands act on. */
  uri: string;
  note: ReactNode;
  canReveal: boolean;
  canHide: boolean;
}) {
  const workbench = useWorkbench();
  useChanges(workbench.menus.changes);
  useChanges(workbench.commands.changes);
  useChanges(workbench.keybindings.changes);
  const base = workbench.keys.lookup(null);
  const groups = workbench.actions("helm/text", (key) =>
    key === "helm.canRevealAll"
      ? canReveal
      : key === "helm.canHideAll"
        ? canHide
        : key === "helm.page"
          ? uri
          : base(key),
  );
  return (
    <div className="flex min-h-8 flex-none items-center gap-2 border-b border-border-subtle pr-2 pl-3 text-xs">
      <span className="min-w-0 flex-1 truncate text-support">{note}</span>
      {groups.length > 0 && <ActionBar inline actions={groups} />}
    </div>
  );
}
