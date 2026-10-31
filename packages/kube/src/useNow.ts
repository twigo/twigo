import { useEffect, useState } from "react";

/** The time, refreshed every `ms`, for ages. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, ms);
    return () => {
      clearInterval(timer);
    };
  }, [ms]);
  return now;
}
