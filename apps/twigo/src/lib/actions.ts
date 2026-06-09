import { useConnections } from "@/store/connections";
import { openPublish, openResponder } from "@/lib/editor";

function liveTarget(): string | undefined {
  const { activeContext, connected } = useConnections.getState();
  if (activeContext && connected[activeContext]?.connected)
    return activeContext;
  return Object.values(connected).find((i) => i.connected)?.name;
}

export function newPublish() {
  const target = liveTarget();
  if (target) openPublish(target);
}

export function newResponder() {
  const target = liveTarget();
  if (target) openResponder(target);
}
