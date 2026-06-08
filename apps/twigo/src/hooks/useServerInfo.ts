import { useEffect, useState } from "react";
import { serverInfo, type ServerDetails } from "@/lib/api";

// Fetches server details for a connection, with a refresh trigger. Keeps the
// data lifecycle out of the panel so the panel is pure presentation.
export function useServerInfo(connId: string) {
  const [data, setData] = useState<ServerDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    serverInfo(connId)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connId, reloadKey]);

  function refresh() {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }

  return { data, error, loading, refresh };
}
