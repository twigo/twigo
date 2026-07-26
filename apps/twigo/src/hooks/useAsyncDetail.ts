import { useEffect, useRef, useState, type DependencyList } from "react";
import { ipcError } from "@/lib/api";

export interface AsyncDetail<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  // Why the last background refresh failed, while the shown data still stands.
  staleReason: string | null;
  refresh: () => void;
}

// One implementation of the detail-panel data lifecycle: fetch on mount and
// whenever `deps` change, ignore a resolved result after unmount, expose a
// `refresh()`, and keep the last data on error. `fetcher` is a fresh closure
// each render, so `deps` (not the closure) is the real dependency set.
// `pollMs` adds a background refresh for panels that show live numbers.
export function useAsyncDetail<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList,
  pollMs?: number,
): AsyncDetail<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [staleReason, setStaleReason] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const latest = useRef(fetcher);
  useEffect(() => {
    latest.current = fetcher;
  });

  useEffect(() => {
    let cancelled = false;
    fetcher()
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
          setStaleReason(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(ipcError(e).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reloadKey]);

  // Never flips `loading` (the spinner would flicker every tick) and never
  // drops good data for a transient failure - it marks the panel stale instead.
  useEffect(() => {
    if (!pollMs) return;
    let cancelled = false;
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      latest
        .current()
        .then((d) => {
          if (!cancelled) {
            setData(d);
            setError(null);
            setStaleReason(null);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) setStaleReason(ipcError(e).message);
        });
    }, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, pollMs]);

  function refresh() {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }

  return { data, error, loading, staleReason, refresh };
}
