import { describe, it, expect } from "vitest";
import {
  buildStreamPatch,
  diffStreamPatch,
  type StreamFormInitial,
} from "./streamForm";

const base: StreamFormInitial = {
  name: "ORDERS",
  subjects: "orders.>, audit.*",
  storage: "file",
  retention: "limits",
  discard: "old",
  maxMsgs: "-1",
  maxBytes: "-1",
  maxAgeSec: "0",
  replicas: "1",
};

describe("buildStreamPatch", () => {
  it("normalizes form fields into the wire patch", () => {
    expect(buildStreamPatch(base)).toEqual({
      name: "ORDERS",
      subjects: ["orders.>", "audit.*"],
      storage: "file",
      retention: "limits",
      discard: "old",
      max_msgs: -1,
      max_bytes: -1,
      max_age: 0,
      num_replicas: 1,
    });
  });

  it("converts max age seconds to nanos and falls back on junk numbers", () => {
    const patch = buildStreamPatch({
      ...base,
      maxAgeSec: "60",
      maxMsgs: "not-a-number",
      replicas: "",
    });
    expect(patch.max_age).toBe(60_000_000_000);
    expect(patch.max_msgs).toBe(-1);
    expect(patch.num_replicas).toBe(1);
  });
});

describe("diffStreamPatch", () => {
  it("returns nothing when the form is untouched", () => {
    expect(diffStreamPatch(base, { ...base })).toEqual([]);
  });

  it("ignores formatting-only edits that normalize to the same patch", () => {
    expect(
      diffStreamPatch(base, { ...base, subjects: "orders.> ,audit.*  ," }),
    ).toEqual([]);
  });

  it("reports only the fields that actually change, with readable values", () => {
    const changes = diffStreamPatch(base, {
      ...base,
      subjects: "orders.>",
      maxMsgs: "500",
      maxAgeSec: "60",
    });
    expect(changes).toEqual([
      { key: "subjects", from: "orders.>, audit.*", to: "orders.>" },
      { key: "max_msgs", from: "unlimited", to: "500" },
      { key: "max_age", from: "unlimited", to: "60s" },
    ]);
  });
});
