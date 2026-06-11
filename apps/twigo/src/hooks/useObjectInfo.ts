import { useEffect, useState } from "react";
import { objObjectInfo, type ObjDetail } from "@/lib/api";

export function useObjectInfo(connId: string, bucket: string, name: string) {
  const [data, setData] = useState<ObjDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    objObjectInfo(connId, bucket, name)
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
  }, [connId, bucket, name, reloadKey]);

  return {
    data,
    error,
    loading,
    refresh: () => {
      setLoading(true);
      setReloadKey((k) => k + 1);
    },
  };
}
