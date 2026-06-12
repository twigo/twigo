import { objObjectInfo } from "@/lib/api";
import { useAsyncDetail } from "./useAsyncDetail";

export function useObjectInfo(connId: string, bucket: string, name: string) {
  return useAsyncDetail(
    () => objObjectInfo(connId, bucket, name),
    [connId, bucket, name],
  );
}
