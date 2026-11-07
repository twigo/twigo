import { useEffect, useState } from "react";

const TICK_MS = 1000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function tick() {
  for (const listener of listeners) listener();
}

function restart() {
  clearInterval(timer);
  timer = undefined;
  if (listeners.size > 0 && !document.hidden) {
    timer = setInterval(tick, TICK_MS);
  }
}

function onVisibility() {
  restart();
  if (!document.hidden) tick();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    document.addEventListener("visibilitychange", onVisibility);
  }
  listeners.add(listener);
  if (timer === undefined) restart();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    document.removeEventListener("visibilitychange", onVisibility);
    restart();
  };
}

/**
 * The time, refreshed every second while the document is visible. Every caller
 * shares one timer, so that the page wakes once however many ages it shows.
 */
export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(
    () =>
      subscribe(() => {
        setNow(Date.now());
      }),
    [],
  );
  return now;
}
