import { useConnections, selectFirstLive } from "@/store/connections";
import { openPublish, openResponder } from "@/lib/editor";

function liveTarget(): string | undefined {
  return selectFirstLive(useConnections.getState());
}

export function newPublish() {
  const target = liveTarget();
  if (!target) return;
  useConnections.getState().setActive(target);
  openPublish(target);
}

export function newResponder() {
  const target = liveTarget();
  if (!target) return;
  useConnections.getState().setActive(target);
  openResponder(target);
}
