import {
  jsListStreams,
  jsListConsumers,
  type StreamSummary,
  type ConsumerSummary,
} from "@/lib/api";
import { createConnTreeStore } from "@/store/connTree";

// Streams (parents) → consumers (children), loaded lazily on expand.
export const useJetStream = createConnTreeStore<StreamSummary, ConsumerSummary>(
  {
    loadParents: (connId) => jsListStreams(connId),
    loadChildren: (connId, stream) => jsListConsumers(connId, stream),
    childNoun: "consumers",
  },
);
