import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useUi, resolveTheme } from "./ui";

function mockMatchMedia(dark: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((media: string) => ({
      matches: dark,
      media,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

describe("ui theme store", () => {
  beforeEach(() => {
    useUi.setState({ theme: "dark", resolvedTheme: "dark" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves an explicit choice directly", () => {
    useUi.getState().setTheme("light");
    expect(useUi.getState().theme).toBe("light");
    expect(useUi.getState().resolvedTheme).toBe("light");
  });

  it("system theme follows the OS preference", () => {
    mockMatchMedia(true);
    useUi.getState().setTheme("system");
    expect(useUi.getState().theme).toBe("system");
    expect(useUi.getState().resolvedTheme).toBe("dark");
    expect(resolveTheme("system")).toBe("dark");
  });

  it("syncResolvedTheme recomputes when the OS preference flips", () => {
    mockMatchMedia(false);
    useUi.getState().setTheme("system");
    expect(useUi.getState().resolvedTheme).toBe("light");
    mockMatchMedia(true);
    useUi.getState().syncResolvedTheme();
    expect(useUi.getState().resolvedTheme).toBe("dark");
  });

  it("toggle flips to an explicit opposite of what is shown", () => {
    mockMatchMedia(true);
    useUi.getState().setTheme("system");
    expect(useUi.getState().resolvedTheme).toBe("dark");
    useUi.getState().toggleTheme();
    expect(useUi.getState().theme).toBe("light");
    expect(useUi.getState().resolvedTheme).toBe("light");
  });

  it("defaults activeView to empty so the shell resolves the module default", () => {
    // The shell must not hardcode a domain view id; an empty default is resolved
    // to the module's default view at read time (ActivityBar/Sidebar).
    expect(useUi.getInitialState().activeView).toBe("");
  });
});
