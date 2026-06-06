import { describe, it, expect, beforeEach } from "vitest";
import { useSettings } from "./settings";

describe("settings store", () => {
  beforeEach(() => {
    useSettings.setState({ contextDir: null });
  });

  it("stores a trimmed path", () => {
    useSettings.getState().setContextDir("  /tmp/nats  ");
    expect(useSettings.getState().contextDir).toBe("/tmp/nats");
  });

  it("treats empty or whitespace as null", () => {
    useSettings.getState().setContextDir("   ");
    expect(useSettings.getState().contextDir).toBeNull();
    useSettings.getState().setContextDir("");
    expect(useSettings.getState().contextDir).toBeNull();
  });
});
