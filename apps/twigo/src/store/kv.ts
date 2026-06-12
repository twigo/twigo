import {
  kvListBuckets,
  kvListKeys,
  type KvBucketSummary,
  type KvEntrySummary,
} from "@/lib/api";
import { createConnTreeStore } from "@/store/connTree";

// Buckets (parents) → keys (children), loaded lazily on expand.
export const useKv = createConnTreeStore<KvBucketSummary, KvEntrySummary>({
  loadParents: (connId) => kvListBuckets(connId),
  loadChildren: (connId, bucket) => kvListKeys(connId, bucket),
  childNoun: "keys",
});
