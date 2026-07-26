import { describe, it, expect, vi } from "vitest";

const getCurrentWindow = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow }));

import { composeTitle, setWindowTitle } from "./title";

describe("composeTitle", () => {
  it("is the bare base name without a suffix", () => {
    expect(composeTitle()).toBe("Twigo");
    expect(composeTitle(null)).toBe("Twigo");
    expect(composeTitle("")).toBe("Twigo");
    expect(composeTitle("   ")).toBe("Twigo");
  });

  it("appends a trimmed suffix", () => {
    expect(composeTitle("prod-eu")).toBe("Twigo - prod-eu");
    expect(composeTitle("  local  ")).toBe("Twigo - local");
  });
});

describe("setWindowTitle", () => {
  it("names the document without touching the native window title", () => {
    setWindowTitle("prod-eu");
    expect(document.title).toBe("Twigo - prod-eu");

    // Setting the native title resets the macOS traffic lights, so this must
    // never reach for the window API again.
    expect(getCurrentWindow).not.toHaveBeenCalled();
  });
});
