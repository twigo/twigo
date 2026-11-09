import { InlineActions, StatusLabel } from "@twigo/ui";
import {
  useChanges,
  useWorkbench,
  type EditorProps,
  type Lookup,
} from "@twigo/workbench";
import { parseExecUri } from "../uri";
import type { ExecTabs } from "./tabs";
import type { ExecVariants } from "./variants";
import { stateOf } from "./words";

/**
 * What the group shows of the active shell tab at the right of its tab
 * strip (ARCHITECTURE 4.3): where the ending is worded inline, the tab's
 * state and Restart once it ended; in either, the actions of the
 * `editor/title` menu that the tab offers, such as a new shell.
 */
export function ExecActions({
  uri,
  tabs,
  variants,
}: EditorProps & { tabs: ExecTabs; variants: ExecVariants }) {
  const workbench = useWorkbench();
  useChanges(tabs.changes);
  useChanges(workbench.menus.changes);
  useChanges(workbench.keys.changes);
  const input = parseExecUri(uri);
  const status = input && tabs.tab(uri, input).getStatus();
  if (!status) return null;
  const inline = variants.end === "inline";
  const ended = status.state === "ended" || status.state === "restored";
  const base = workbench.keys.lookup(null);
  const lookup: Lookup = (key) => {
    if (key === "execEnded") return inline && ended;
    return key === "execTab" ? true : base(key);
  };
  const { label, tone, pulse } = stateOf(status);
  return (
    <div className="flex items-center gap-2">
      {inline && (
        <StatusLabel tone={tone} {...(pulse && { pulse })} className="text-xs">
          {label}
        </StatusLabel>
      )}
      <InlineActions
        actions={workbench.actions("editor/title", lookup, { uri }).flat()}
      />
    </div>
  );
}
