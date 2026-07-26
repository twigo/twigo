import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  openServerHealth: vi.fn(),
  monitorVarz: vi.fn(),
  monitorJsz: vi.fn(),
  monitorHealthz: vi.fn(),
}));

vi.mock("@/lib/editor", () => ({ openServerHealth: mocks.openServerHealth }));
vi.mock("@/lib/api", () => ({
  monitorVarz: mocks.monitorVarz,
  monitorJsz: mocks.monitorJsz,
  monitorHealthz: mocks.monitorHealthz,
}));

import { MonitorView } from "./MonitorView";
import { useMonitor } from "@/store/monitor";
import { useConnections } from "@/store/connections";

const VARZ = {
  serverId: "S",
  serverName: "nats-1",
  version: "2.14.0",
  uptime: "1d",
  cluster: { name: "" },
  connections: 3,
  totalConnections: 9,
  subscriptions: 12,
  slowConsumers: 0,
  inMsgs: 1,
  outMsgs: 1,
  inBytes: 1,
  outBytes: 1,
  mem: 100,
  cpu: 4,
  lameDuckMode: false,
};

function live() {
  useConnections.setState({
    connected: {
      c: {
        name: "c",
        serverName: "nats-1",
        serverVersion: "2.14.0",
        rttMs: 0,
        jetstream: false,
        maxPayload: 0,
        connected: true,
      },
    },
  });
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

describe("MonitorView", () => {
  beforeEach(() => {
    mocks.openServerHealth.mockReset();
    mocks.monitorVarz.mockReset().mockResolvedValue(VARZ);
    mocks.monitorJsz.mockReset().mockResolvedValue(null);
    mocks.monitorHealthz.mockReset().mockResolvedValue(null);
    useMonitor.setState({ byConn: {} });
    live();
  });
  afterEach(cleanup);

  it("opens the charts tab once the server answers", async () => {
    render(<MonitorView connId="c" filter="" />);
    await flush();

    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(mocks.openServerHealth).toHaveBeenCalledWith("c");
  });

  it("summarises without charting - the tab owns the trends", async () => {
    render(<MonitorView connId="c" filter="" />);
    await flush();

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Throughput")).toBeInTheDocument();
  });

  it("stays on the setup flow instead of opening a tab onto errors", async () => {
    mocks.monitorVarz.mockRejectedValue(new Error("no responders"));

    render(<MonitorView connId="c" filter="" />);
    await flush();

    expect(screen.getByText("Monitoring off")).toBeInTheDocument();
    expect(mocks.openServerHealth).not.toHaveBeenCalled();
  });
});
