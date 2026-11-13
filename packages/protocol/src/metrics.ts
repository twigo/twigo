import type { MetricsState, Usage } from "./generated";

/** What a context that serves the Metrics API says of it: `absent` goes only to an open object. */
export type ServedMetrics = Exclude<MetricsState, "absent">;

/** A usage that draws figures or says why there are none. */
export type ShownUsage = Usage & { readonly state: ServedMetrics };

export function isShown(usage: Usage): usage is ShownUsage {
  return usage.state !== "absent";
}
