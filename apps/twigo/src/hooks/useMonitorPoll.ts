import { useEffect } from "react";
import { useMonitor } from "@/store/monitor";

export const MONITOR_POLL_MS = 3000;
// A floor on the sample spacing, not a lock - see the dedupe in the store.
const MIN_SAMPLE_MS = MONITOR_POLL_MS * 0.75;

export function useMonitorPoll(
  connId: string | null,
  monitoringUrl: string | null,
) {
  const poll = useMonitor((s) => s.poll);
  useEffect(() => {
    if (!connId) return;
    const tick = () => {
      if (document.visibilityState === "visible")
        void poll(connId, monitoringUrl, MIN_SAMPLE_MS);
    };
    tick();
    const id = setInterval(tick, MONITOR_POLL_MS);
    return () => clearInterval(id);
  }, [connId, monitoringUrl, poll]);
}
