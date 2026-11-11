import { InlineActions, StatusLabel } from "@twigo/ui";
import {
  useChanges,
  useWorkbench,
  type EditorProps,
  type Lookup,
} from "@twigo/workbench";
import { parseTerminalUri } from "../uri";
import { stateOf } from "../xterm/words";
import type { TerminalTabs } from "./tabs";

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
  const status = input && tabs.tab(uri, input).getStatus();
  if (!status) return null;
  const ended = status.state === "ended" || status.state === "restored";
  const base = workbench.keys.lookup(null);
  const lookup: Lookup = (key) =>
    key === "terminalRestartable" ? ended : base(key);
  const { label, tone, pulse } = stateOf(status);
  return (
    <div className="flex items-center gap-2">
      <StatusLabel tone={tone} {...(pulse && { pulse })} className="text-xs">
        {label}
      </StatusLabel>
      <InlineActions
        actions={workbench.actions("editor/title", lookup, { uri }).flat()}
      />
    </div>
  );
}
