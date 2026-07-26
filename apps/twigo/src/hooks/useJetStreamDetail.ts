import { jsStreamDetail, jsConsumerDetail } from "@/lib/api";
import { useAsyncDetail } from "./useAsyncDetail";

export function useStreamDetail(connId: string, stream: string) {
  return useAsyncDetail(() => jsStreamDetail(connId, stream), [connId, stream]);
}

// Lag, in-flight and redeliveries move constantly, and the lag trend needs a
// steady sample rate - so this panel refreshes itself while it is open.
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
