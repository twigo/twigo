import { useChanges, useWorkbench } from "../react";
import { ContextDot } from "@twigo/ui";
import { onlyColor } from "./spaceBadge";

export function SpaceItem() {
  const { spaces } = useWorkbench();
  useChanges(spaces.changes);
  const space = spaces.active;
  if (!space) return null;
  const color = onlyColor(space);
  return (
    <span className="flex items-center gap-1.5">
      {color && <ContextDot color={color} />}
      {space.contexts.map((context) => context.name).join(" + ")}
    </span>
  );
}

export function NamespacesItem() {
  const { spaces } = useWorkbench();
  useChanges(spaces.changes);
  const space = spaces.active;
  if (!space) return null;
  const { namespaces } = spaces.state(space.id);
  return (
    <span className="opacity-80">
      {namespaces.length === 0
        ? "all namespaces"
        : `ns: ${namespaces.join(", ")}`}
    </span>
  );
}

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
