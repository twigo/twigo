import { useEffect, useState } from "react";
import {
  kvGetEntry,
  kvBucketInfo,
  kvHistory,
  type KvBucketDetail,
  type KvEntrySummary,
} from "@/lib/api";
import { useAsyncDetail } from "./useAsyncDetail";

export function useKvEntry(
  connId: string,
  bucket: string,
  key: string,
  revision: number | null,
) {
  return useAsyncDetail(
    () => kvGetEntry(connId, bucket, key, revision),
    [connId, bucket, key, revision],
  );
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
