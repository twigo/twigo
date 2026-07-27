import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useToasts } from "@/store/toasts";
import { useUpdateCheck } from "@/store/updateCheck";

const { check, relaunch } = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));

import { checkForUpdates } from "./updater";

const w = window as unknown as Record<string, unknown>;

describe("checkForUpdates", () => {
  beforeEach(() => {
    useToasts.setState({ toasts: [], queue: [] });
    useUpdateCheck.setState({ failures: 0, lastError: null });
    check.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    w.__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete w.__TAURI_INTERNALS__;
  });

  it("does nothing outside Tauri", async () => {
    delete w.__TAURI_INTERNALS__;
    await checkForUpdates();
    expect(check).not.toHaveBeenCalled();
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("reports up-to-date on a manual check", async () => {
    check.mockResolvedValue(null);
    await checkForUpdates();
    const t = useToasts.getState().toasts[0];
    expect(t?.kind).toBe("success");
    expect(t?.message).toMatch(/latest/i);
  });

  it("stays silent when up to date on the launch check", async () => {
    check.mockResolvedValue(null);
    await checkForUpdates({ silent: true });
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("offers an actionable toast when an update exists", async () => {
    check.mockResolvedValue({ version: "0.2.0", downloadAndInstall: vi.fn() });
    await checkForUpdates();
    const t = useToasts.getState().toasts[0];
    expect(t?.message).toMatch(/0\.2\.0/);
    expect(t?.action?.label).toMatch(/install/i);
  });

  it("surfaces a manual check error", async () => {
    check.mockRejectedValue(new Error("network"));
    await checkForUpdates();
    expect(useToasts.getState().toasts[0]?.kind).toBe("error");
  });

  it("logs and records a silent failure instead of discarding it", async () => {
    check.mockRejectedValue(new Error("404 Not Found"));
    await checkForUpdates({ silent: true });
    expect(console.error).toHaveBeenCalled();
    expect(useUpdateCheck.getState()).toMatchObject({
      failures: 1,
      lastError: "404 Not Found",
    });
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("warns once the silent failures reach the limit, then re-arms", async () => {
    check.mockRejectedValue(new Error("404 Not Found"));
    await checkForUpdates({ silent: true });
    await checkForUpdates({ silent: true });
    expect(useToasts.getState().toasts).toHaveLength(0);

    await checkForUpdates({ silent: true });
    const t = useToasts.getState().toasts[0];
    expect(t?.kind).toBe("warning");
    expect(t?.message).toMatch(/keep failing/i);
    expect(t?.action?.label).toMatch(/check again/i);
    // Counter reset so the warning repeats every N failures, not every launch.
    expect(useUpdateCheck.getState().failures).toBe(0);
  });

  it("clears the failure streak once a check succeeds", async () => {
    check.mockRejectedValue(new Error("network"));
    await checkForUpdates({ silent: true });
    expect(useUpdateCheck.getState().failures).toBe(1);

    check.mockReset();
    check.mockResolvedValue(null);
    await checkForUpdates({ silent: true });
    expect(useUpdateCheck.getState()).toMatchObject({
      failures: 0,
      lastError: null,
    });
  });

  it("counts a failed manual check toward the streak", async () => {
    check.mockRejectedValue(new Error("network"));
    await checkForUpdates();
    expect(useUpdateCheck.getState().failures).toBe(1);
  });
});
