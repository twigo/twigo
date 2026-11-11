import { InlineActions, StatusLabel } from "@twigo/ui";
import {
  useChanges,
  useWorkbench,
  type EditorProps,
  type Lookup,
} from "@twigo/workbench";
import { parseTerminalUri } from "../uri";
import { variant } from "../variants";
import { stateOf } from "../xterm/words";
import { KindChip } from "./KindChip";
import type { TerminalTabs } from "./tabs";
import { useKind } from "./useKind";

/**
 * What the group shows of the active terminal tab at the right of its tab
 * strip (ARCHITECTURE 4.3): its state, and the actions of the
 * `editor/title` menu that it offers, Restart once it ended.
 */
export function TerminalActions({
  uri,
  tabs,
}: EditorProps & { tabs: TerminalTabs }) {
  const workbench = useWorkbench();
  useChanges(tabs.changes);
  useChanges(workbench.menus.changes);
  useChanges(workbench.keys.changes);
  const input = parseTerminalUri(uri);
  const tab = input && tabs.tab(uri, input);
  const words = useKind(tab);
  const status = tab?.getStatus();
  if (!status) return null;
  const ended = status.state === "ended" || status.state === "restored";
  const restartable = ended || words?.warning !== undefined;
  const base = workbench.keys.lookup(null);
  const lookup: Lookup = (key) =>
    key === "terminalRestartable" ? restartable : base(key);
  const { label, tone, pulse } = stateOf(status);
  return (
    <div className="flex items-center gap-2">
      {words && variant("kind", ["chip", "icon", "line"]) === "chip" && (
        <KindChip words={words} />
      )}
      <StatusLabel tone={tone} {...(pulse && { pulse })} className="text-xs">
        {label}
      </StatusLabel>
      <InlineActions
        actions={workbench.actions("editor/title", lookup, { uri }).flat()}
      />
    </div>
  );
}
