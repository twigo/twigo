import { InlineActions, StatusLabel } from "@twigo/ui";
import { useChanges, useWorkbench, type EditorProps } from "@twigo/workbench";
import { parsePfUri } from "../uri";
import { withForward } from "./keys";
import type { Forwards } from "./service";
import { stateOf } from "./words";

/**
 * What the group shows of the active forward tab at the right of its tab
 * strip (ARCHITECTURE 4.3): its state, and the actions of the `editor/title`
 * menu that its state offers.
 */
export function ForwardActions({
  uri,
  forwards,
}: EditorProps & { forwards: Forwards }) {
  const workbench = useWorkbench();
  useChanges(forwards.changes);
  useChanges(workbench.menus.changes);
  useChanges(workbench.keys.changes);
  const input = parsePfUri(uri);
  const forward = input && forwards.get(input.id);
  if (!forward) return null;
  const { label, tone, pulse } = stateOf(forward);
  const lookup = withForward(workbench.keys.lookup(null), forward);
  return (
    <div className="flex items-center gap-2">
      <StatusLabel tone={tone} {...(pulse && { pulse })} className="text-xs">
        {label}
      </StatusLabel>
      <InlineActions
        actions={workbench
          .actions("editor/title", lookup, { id: forward.id })
          .flat()}
      />
    </div>
  );
}
