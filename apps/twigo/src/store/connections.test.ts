import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ContextSummary, ConnInfo } from "@/lib/api";

const {
  listContexts,
  connect,
  disconnect,
  connInfo,
  connRtt,
  deleteContext,
  syncConnReadonly,
  pushMock,
} = vi.hoisted(() => ({
  listContexts: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  connInfo: vi.fn(),
  connRtt: vi.fn(() => Promise.resolve(1)),
  deleteContext: vi.fn(),
  syncConnReadonly: vi.fn(() => Promise.resolve()),
  pushMock: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  listContexts,
  connect,
  disconnect,
  connInfo,
  connRtt,
  deleteContext,
  syncConnReadonly,
}));
vi.mock("@/lib/editor", () => ({ closeEditorsForConn: vi.fn() }));
vi.mock("@/store/toasts", () => ({
  useToasts: { getState: () => ({ push: pushMock }) },
}));

import { useConnections } from "./connections";
import { useWorkspace } from "./workspace";
import { useReadOnly } from "./readonly";

function ctx(name: string, selected = false): ContextSummary {
  return {
    name,
    description: "",
    url: `nats://${name}:4222`,
    authMethod: "none",
    hasTls: false,
    selected,
  };
}

function info(name = "a"): ConnInfo {
  return {
    name,
    server: {
      serverName: "s",
      serverVersion: "2",
      jetstream: false,
      maxPayload: 0,
    },
  };
}

describe("connections active-context persistence", () => {
  beforeEach(() => {
    listContexts.mockReset();
    useWorkspace.setState({
      activeContext: null,
      lastConnected: [],
      watching: {},
    });
    useConnections.setState({
      activeContext: null,
      contexts: [],
      status: "idle",
    });
  });

  it("persists the active context to the workspace on setActive", () => {
    useConnections.getState().setActive("prod-eu");
    expect(useConnections.getState().activeContext).toBe("prod-eu");
    expect(useWorkspace.getState().activeContext).toBe("prod-eu");
  });

  it("restores the remembered active context on load over the nats-selected one", async () => {
    useWorkspace.setState({ activeContext: "prod-us" });
    listContexts.mockResolvedValue([ctx("prod-eu", true), ctx("prod-us")]);
    await useConnections.getState().load();
    expect(useConnections.getState().activeContext).toBe("prod-us");
  });

  it("falls back to the nats-selected context when the remembered one is gone", async () => {
    useWorkspace.setState({ activeContext: "deleted" });
    listContexts.mockResolvedValue([ctx("prod-eu", true)]);
    await useConnections.getState().load();
    expect(useConnections.getState().activeContext).toBe("prod-eu");
  });

  it("prunes persisted state for contexts that disappeared, on load", async () => {
    useWorkspace.setState({
      layouts: { gone: {} as never },
      lastConnected: ["gone"],
      watching: { gone: ">" },
      activeContext: "gone",
    });
    listContexts.mockResolvedValue([ctx("prod-eu", true)]);
    await useConnections.getState().load();
    const w = useWorkspace.getState();
    expect(w.layouts.gone).toBeUndefined();
    expect(w.lastConnected).toEqual([]);
    expect(w.activeContext).not.toBe("gone");
  });

  it("removeContext disconnects a live connection and clears the active selection", async () => {
    disconnect.mockResolvedValue(undefined);
    deleteContext.mockResolvedValue(undefined);
    listContexts.mockResolvedValue([ctx("other")]);
    useConnections.setState({
      activeContext: "doomed",
      connected: { doomed: info("doomed") },
    });

    await useConnections.getState().removeContext("doomed");

    // The live client is torn down (so messages stop) before the file is removed.
    expect(disconnect).toHaveBeenCalledWith("doomed");
    expect(deleteContext).toHaveBeenCalledWith(null, "doomed");
    // The deleted context is no longer the active selection.
    expect(useConnections.getState().activeContext).not.toBe("doomed");
  });

  it("removeContext deletes a non-connected context without disconnecting", async () => {
    disconnect.mockClear(); // beforeEach only resets listContexts
    deleteContext.mockResolvedValue(undefined);
    listContexts.mockResolvedValue([]);
    useConnections.setState({ activeContext: null, connected: {} });

    await useConnections.getState().removeContext("idle-ctx");

    expect(disconnect).not.toHaveBeenCalled();
    expect(deleteContext).toHaveBeenCalledWith(null, "idle-ctx");
  });

  it("marks a connection reconnecting on a disconnected event", () => {
    useConnections.setState({
      connected: { a: info() },
    });
    useConnections.getState().onEvent("a", "disconnected");
    expect(useConnections.getState().connected.a?.server).toBeNull();
  });

  it("drops a connection on a closed event", () => {
    useConnections.setState({ connected: { a: info() } });
    useConnections.getState().onEvent("a", "closed");
    expect(useConnections.getState().connected.a).toBeUndefined();
  });

  it("tracks reconnect backoff and clears it once connected", () => {
    useConnections.setState({ reconnecting: {} });
    useConnections.getState().onReconnect("a", 3, 2000);
    const rc = useConnections.getState().reconnecting.a;
    expect(rc?.attempt).toBe(3);
    expect(rc?.delayMs).toBe(2000);

    connInfo.mockResolvedValue(info("a"));
    useConnections.getState().onEvent("a", "connected");
    expect(useConnections.getState().reconnecting.a).toBeUndefined();
  });
});

describe("connections link toasts", () => {
  const GRACE = 3500;

  beforeEach(() => {
    useConnections.setState({ connected: {}, reconnecting: {} });
    // Drop any drop-watch leaked from an earlier test before faking timers.
    useConnections.getState().onEvent("a", "closed");
    pushMock.mockClear();
    connInfo.mockResolvedValue(info("a"));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("warns only once a drop outlasts the grace window", () => {
    useConnections.setState({
      connected: { a: info() },
    });
    useConnections.getState().onEvent("a", "disconnected");
    expect(pushMock).not.toHaveBeenCalled(); // deferred, not immediate
    vi.advanceTimersByTime(GRACE);
    expect(pushMock).toHaveBeenCalledWith(
      "warning",
      expect.stringContaining("Lost connection to a"),
      { key: "conn:a:link" },
    );
  });

  it("stays silent for a transient blip that self-heals", () => {
    useConnections.setState({
      connected: { a: info() },
    });
    useConnections.getState().onEvent("a", "disconnected");
    useConnections.getState().onEvent("a", "connected"); // back within grace
    vi.advanceTimersByTime(GRACE);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("announces recovery only after an outage was shown", () => {
    useConnections.setState({
      connected: { a: info() },
    });
    useConnections.getState().onEvent("a", "disconnected");
    vi.advanceTimersByTime(GRACE); // outage announced
    pushMock.mockClear();
    useConnections.getState().onEvent("a", "connected");
    expect(pushMock).toHaveBeenCalledWith(
      "success",
      expect.stringContaining("Reconnected to a"),
      { key: "conn:a:link" },
    );
  });

  it("stays silent when the user is the one disconnecting", async () => {
    useConnections.setState({
      connected: { a: info() },
    });
    disconnect.mockResolvedValue(undefined);
    const pending = useConnections.getState().disconnect("a");
    useConnections.getState().onEvent("a", "disconnected");
    vi.advanceTimersByTime(GRACE);
    await pending;
    expect(pushMock).not.toHaveBeenCalledWith(
      "warning",
      expect.stringContaining("Lost connection"),
      { key: "conn:a:link" },
    );
  });

  it("dedupes a fault that repeats on every reconnect attempt", () => {
    useConnections
      .getState()
      .onEvent("a", "serverError", "authorization violation");
    useConnections
      .getState()
      .onEvent("a", "serverError", "authorization violation");
    const errors = pushMock.mock.calls.filter((c) => c[0] === "error");
    expect(errors).toEqual([
      ["error", "a: authorization violation", { key: "conn:a:err" }],
    ]);
  });
});

describe("read-only mirror (SEC-4)", () => {
  it("syncs the lock set to the backend on every change, in order", async () => {
    syncConnReadonly.mockClear();
    useReadOnly.getState().setReadOnly("prod", true);
    useReadOnly.getState().setReadOnly("prod", false);
    await vi.waitFor(() => {
      expect(syncConnReadonly).toHaveBeenCalledTimes(2);
    });
    expect(syncConnReadonly).toHaveBeenNthCalledWith(1, ["prod"]);
    expect(syncConnReadonly).toHaveBeenNthCalledWith(2, []);
  });
});

describe("rtt sampling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    connRtt.mockReset();
    connInfo.mockReset();
    connInfo.mockResolvedValue(info("a"));
    disconnect.mockResolvedValue(undefined);
    useConnections.setState({ connected: { a: info() }, rtt: {} });
  });
  afterEach(() => {
    useConnections.getState().onEvent("a", "disconnected");
    vi.useRealTimers();
  });

  it("takes a first sample as soon as the link is up", async () => {
    connRtt.mockResolvedValue(1.4);
    useConnections.getState().onEvent("a", "connected");
    await vi.advanceTimersByTimeAsync(0);
    expect(useConnections.getState().rtt.a).toBe(1.4);
  });

  it("keeps sampling on an interval, smoothing toward the newest value", async () => {
    connRtt.mockResolvedValueOnce(1).mockResolvedValueOnce(3);
    useConnections.getState().onEvent("a", "connected");
    await vi.advanceTimersByTimeAsync(0);
    expect(useConnections.getState().rtt.a).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useConnections.getState().rtt.a).toBe(2);
  });

  it("runs one sampler no matter how many times the link-up paths fire", async () => {
    connRtt.mockResolvedValue(1);
    useConnections.getState().onEvent("a", "connected");
    useConnections.getState().onEvent("a", "connected");
    await vi.advanceTimersByTimeAsync(0);
    expect(connRtt).toHaveBeenCalledTimes(1);
  });

  it("stops sampling and clears the value when the link drops", async () => {
    connRtt.mockResolvedValue(1);
    useConnections.getState().onEvent("a", "connected");
    await vi.advanceTimersByTimeAsync(0);
    useConnections.getState().onEvent("a", "disconnected");
    expect(useConnections.getState().rtt.a).toBeUndefined();
    connRtt.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connRtt).not.toHaveBeenCalled();
  });

  it("clears the value on a deliberate disconnect", async () => {
    connRtt.mockResolvedValue(1);
    useConnections.getState().onEvent("a", "connected");
    await vi.advanceTimersByTimeAsync(0);
    await useConnections.getState().disconnect("a");
    expect(useConnections.getState().rtt.a).toBeUndefined();
    connRtt.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connRtt).not.toHaveBeenCalled();
  });

  it("discards a probe that resolves after the link cycled", async () => {
    let resolveProbe!: (ms: number) => void;
    connRtt.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    useConnections.getState().onEvent("a", "connected");
    useConnections.getState().onEvent("a", "disconnected");
    resolveProbe(9);
    await vi.advanceTimersByTimeAsync(0);
    expect(useConnections.getState().rtt.a).toBeUndefined();
  });

  it("gives up after repeated failures instead of probing forever", async () => {
    connRtt.mockRejectedValue(new Error("Permissions Violation for Publish"));
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    useConnections.getState().onEvent("a", "connected");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(errSpy).toHaveBeenCalledTimes(1);
    connRtt.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connRtt).not.toHaveBeenCalled();
    expect(useConnections.getState().rtt.a).toBeUndefined();
    errSpy.mockRestore();
  });

  it("a fresh link after giving up starts probing again", async () => {
    connRtt.mockRejectedValue(new Error("nope"));
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    useConnections.getState().onEvent("a", "connected");
    await vi.advanceTimersByTimeAsync(20_000);
    useConnections.getState().onEvent("a", "disconnected");

    connRtt.mockReset();
    connRtt.mockResolvedValue(2);
    useConnections.getState().onEvent("a", "connected");
    await vi.advanceTimersByTimeAsync(0);
    expect(useConnections.getState().rtt.a).toBe(2);
    errSpy.mockRestore();
  });
});
