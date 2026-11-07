import { useEffect, useState } from "react";

/** The time, refreshed every `ms` while the document is visible, for ages. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = () => {
      setNow(Date.now());
    };
    let timer = document.hidden ? undefined : setInterval(tick, ms);
    const onVisibility = () => {
      clearInterval(timer);
      timer = undefined;
      if (document.hidden) return;
      tick();
      timer = setInterval(tick, ms);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ms]);
  return now;
}
