import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useToasts } from "@/store/toasts";

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
    check.mockReset();
    w.__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
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
});
