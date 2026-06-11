import { useEffect, useState } from "react";
import {
  jsStreamDetail,
  jsConsumerDetail,
  type StreamDetail,
  type ConsumerDetail,
} from "@/lib/api";

export function useStreamDetail(connId: string, stream: string) {
  const [data, setData] = useState<StreamDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    jsStreamDetail(connId, stream)
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
  }, [connId, stream, reloadKey]);

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

export function useConsumerDetail(
  connId: string,
  stream: string,
  consumer: string,
) {
  const [data, setData] = useState<ConsumerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    jsConsumerDetail(connId, stream, consumer)
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
  }, [connId, stream, consumer, reloadKey]);

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
