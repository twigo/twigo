import { InlineActions, StatusLabel } from "@twigo/ui";
import {
  useChanges,
  useWorkbench,
  type EditorProps,
  type Lookup,
} from "@twigo/workbench";
import { parseExecUri } from "../uri";
import type { ExecTabs } from "./tabs";
import { stateOf } from "./words";

/**
 * What the group shows of the active shell tab at the right of its tab
 * strip (ARCHITECTURE 4.3): its state, and the actions of the
 * `editor/title` menu that it offers, Restart once it ended.
 */
export function ExecActions({ uri, tabs }: EditorProps & { tabs: ExecTabs }) {
  const workbench = useWorkbench();
  useChanges(tabs.changes);
  useChanges(workbench.menus.changes);
  useChanges(workbench.keys.changes);
  const input = parseExecUri(uri);
  const status = input && tabs.tab(uri, input).getStatus();
  if (!status) return null;
  const ended = status.state === "ended" || status.state === "restored";
  const base = workbench.keys.lookup(null);
  const lookup: Lookup = (key) => (key === "execEnded" ? ended : base(key));
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
