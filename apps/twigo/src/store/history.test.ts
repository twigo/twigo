import { describe, it, expect, beforeEach } from "vitest";
import { useHistory } from "./history";

describe("history store", () => {
  beforeEach(() => {
    useHistory.setState({ entries: [], nextId: 1 });
  });

  it("records newest-first with ids and timestamps", () => {
    useHistory.getState().record({
      connId: "c",
      kind: "publish",
      subject: "a",
      payloadB64: "aGk=",
      headers: [],
    });
    useHistory.getState().record({
      connId: "c",
      kind: "request",
      subject: "b",
      payloadB64: "",
      headers: [],
    });
    const [first, second] = useHistory.getState().entries;
    expect(first?.subject).toBe("b");
    expect(second?.subject).toBe("a");
    expect(first?.id).not.toBe(second?.id);
    expect(first?.truncated).toBe(false);
  });

  it("caps at 200 entries", () => {
    for (let i = 0; i < 210; i++) {
      useHistory.getState().record({
        connId: "c",
        kind: "publish",
        subject: `s${i}`,
        payloadB64: "",
        headers: [],
      });
    }
    expect(useHistory.getState().entries).toHaveLength(200);
    expect(useHistory.getState().entries[0]?.subject).toBe("s209");
  });

  it("drops oversized payloads but keeps the entry", () => {
    useHistory.getState().record({
      connId: "c",
      kind: "publish",
      subject: "big",
      payloadB64: "x".repeat(300 * 1024),
      headers: [],
    });
    const e = useHistory.getState().entries[0];
    expect(e?.truncated).toBe(true);
    expect(e?.payloadB64).toBe("");
  });

  it("clears one connection only", () => {
    useHistory.getState().record({
      connId: "a",
      kind: "publish",
      subject: "s",
      payloadB64: "",
      headers: [],
    });
    useHistory.getState().record({
      connId: "b",
      kind: "publish",
      subject: "s",
      payloadB64: "",
      headers: [],
    });
    useHistory.getState().clear("a");
    expect(useHistory.getState().entries.map((e) => e.connId)).toEqual(["b"]);
  });
});
