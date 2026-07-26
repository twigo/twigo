import { jsStreamDetail, jsConsumerDetail } from "@/lib/api";
import { useAsyncDetail } from "./useAsyncDetail";

export function useStreamDetail(connId: string, stream: string) {
  return useAsyncDetail(() => jsStreamDetail(connId, stream), [connId, stream]);
}

// The lag trend needs a steady sample rate, so this panel refreshes itself.
const CONSUMER_POLL_MS = 5000;

export function useConsumerDetail(
  connId: string,
  stream: string,
  consumer: string,
) {
  return useAsyncDetail(
    () => jsConsumerDetail(connId, stream, consumer),
    [connId, stream, consumer],
    CONSUMER_POLL_MS,
  );
}
