import { useEffect, useState } from "react";
import {
  kvGetEntry,
  kvBucketInfo,
  kvHistory,
  type KvEntryDetail,
  type KvBucketDetail,
  type KvEntrySummary,
} from "@/lib/api";

export function useKvEntry(
  connId: string,
  bucket: string,
  key: string,
  revision: number | null,
) {
  const [data, setData] = useState<KvEntryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    kvGetEntry(connId, bucket, key, revision)
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
  }, [connId, bucket, key, revision, reloadKey]);

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

export function useKvBucketInfo(connId: string, bucket: string) {
  const [data, setData] = useState<KvBucketDetail | null>(null);
  useEffect(() => {
    let cancelled = false;
    kvBucketInfo(connId, bucket)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connId, bucket]);
  return data;
}

export function useKvHistory(
  connId: string,
  bucket: string,
  key: string,
  reloadKey: number,
) {
  const [data, setData] = useState<KvEntrySummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    kvHistory(connId, bucket, key)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connId, bucket, key, reloadKey]);
  return data;
}
