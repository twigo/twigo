import { jsStreamDetail, jsConsumerDetail } from "@/lib/api";
import { useAsyncDetail } from "./useAsyncDetail";

export function useStreamDetail(connId: string, stream: string) {
  return useAsyncDetail(
    () => jsStreamDetail(connId, stream),
    [connId, stream],
  );
}

export function useConsumerDetail(
  connId: string,
  stream: string,
  consumer: string,
) {
  return useAsyncDetail(
    () => jsConsumerDetail(connId, stream, consumer),
    [connId, stream, consumer],
  );
}
