import { describe, it, expect, beforeEach } from "vitest";
import { useCommandHistory } from "./commandHistory";

describe("command history", () => {
  beforeEach(() => useCommandHistory.setState({ recent: [] }));

  it("records most-recent-first", () => {
    const { record } = useCommandHistory.getState();
    record("a");
    record("b");
    expect(useCommandHistory.getState().recent).toEqual(["b", "a"]);
  });

  it("dedupes, moving a re-run command to the front", () => {
    const { record } = useCommandHistory.getState();
    record("a");
    record("b");
    record("a");
    expect(useCommandHistory.getState().recent).toEqual(["a", "b"]);
  });

  it("caps the list at 8", () => {
    const { record } = useCommandHistory.getState();
    for (let i = 0; i < 12; i++) record(`c${i}`);
    const recent = useCommandHistory.getState().recent;
    expect(recent).toHaveLength(8);
    expect(recent[0]).toBe("c11");
    expect(recent).not.toContain("c0");
  });
});
