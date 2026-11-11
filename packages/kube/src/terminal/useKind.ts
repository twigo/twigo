import { useChanges, useWorkbench } from "@twigo/workbench";
import { describeKind, type KindWords } from "./kind";
import type { TerminalTab } from "./tabs";

/** The words of a terminal's kind, following its context's mode; none for a tab nothing started. */
export function useKind(tab: TerminalTab | undefined): KindWords | undefined {
  const { spaces, catalog } = useWorkbench();
  useChanges(spaces.changes);
  useChanges(catalog.changes);
  const kind = tab?.kind;
  if (!tab || !kind) return undefined;
  const [context] =
    spaces.list.find((space) => space.id === tab.input.space)?.contexts ?? [];
  if (context === undefined) return undefined;
  return describeKind(kind, context, catalog.find(context)?.access.mode);
}
