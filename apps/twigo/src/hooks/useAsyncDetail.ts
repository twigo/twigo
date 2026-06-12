import { useEffect, useState, type DependencyList } from "react";
import { ipcError } from "@/lib/api";

export interface AsyncDetail<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

// One implementation of the detail-panel data lifecycle: fetch on mount and
// whenever `deps` change, ignore a resolved result after unmount, expose a
// `refresh()`, and keep the last data on error. `fetcher` is a fresh closure
// each render, so `deps` (not the closure) is the real dependency set.
export function useAsyncDetail<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList,
): AsyncDetail<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetcher()
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
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

  function refresh() {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }

  return { data, error, loading, refresh };
}
