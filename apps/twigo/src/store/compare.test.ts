import { describe, it, expect, beforeEach } from "vitest";
import { useCompare } from "./compare";
import type { StreamMessage } from "@twigo/utils";

function msg(id: number): StreamMessage {
  return {
    id,
    receivedAt: 0,
    subject: "s",
    reply: null,
    payloadB64: "",
    headers: [],
    size: 0,
    preview: "",
  };
}

describe("compare store", () => {
  beforeEach(() => useCompare.setState({ pinned: null }));

  it("pins and clears a message snapshot", () => {
    const m = msg(1);
    useCompare.getState().pin(m);
    expect(useCompare.getState().pinned).toBe(m);
    useCompare.getState().clear();
    expect(useCompare.getState().pinned).toBeNull();
  });
});
