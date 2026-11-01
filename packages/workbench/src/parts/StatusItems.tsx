import { useChanges, useWorkbench } from "../react";

/** VS Code's hint while a chord waits for its next key. */
export function ChordItem() {
  const { keybindings } = useWorkbench();
  useChanges(keybindings.changes);
  const { pending } = keybindings;
  if (pending.length === 0) return null;
  return (
    <span role="status">
      ({keybindings.label(pending)}) was pressed. Waiting for the next key…
    </span>
  );
}
