import {
  objListBuckets,
  objListObjects,
  type ObjBucketSummary,
  type ObjSummary,
} from "@/lib/api";
import { createConnTreeStore } from "@/store/connTree";

// Buckets (parents) → objects (children), loaded lazily on expand.
export const useObjStore = createConnTreeStore<ObjBucketSummary, ObjSummary>({
  loadParents: (connId) => objListBuckets(connId),
  loadChildren: (connId, bucket) => objListObjects(connId, bucket),
  childNoun: "objects",
});
