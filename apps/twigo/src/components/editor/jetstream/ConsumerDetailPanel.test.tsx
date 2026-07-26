import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ consumerDetail: vi.fn() }));

vi.mock("@/lib/api", () => ({
  jsConsumerDetail: mocks.consumerDetail,
  jsPauseConsumer: vi.fn(),
  jsResumeConsumer: vi.fn(),
  jsDeleteConsumer: vi.fn(),
  ipcError: (e: unknown) => ({
    message: e instanceof Error ? e.message : String(e),
  }),
}));
vi.mock("@/lib/editor", () => ({ closeConsumerDetail: vi.fn() }));

import { ConsumerDetailPanel } from "./ConsumerDetailPanel";
import { useSeries } from "@/store/series";

function detail(numPending: number) {
  return {
    numPending,
    numAckPending: 0,
    numRedelivered: 0,
    numWaiting: 0,
    deliveredConsumerSeq: 0,
    deliveredStreamSeq: 0,
    ackFloorConsumerSeq: 0,
    ackFloorStreamSeq: 0,
    paused: false,
    config: {},
  };
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
  });

const tick = () =>
  act(async () => {
    vi.advanceTimersByTime(5000);
    await Promise.resolve();
  });

function panel() {
  render(<ConsumerDetailPanel connId="c" stream="ORDERS" consumer="workers" />);
}

describe("ConsumerDetailPanel", () => {
  beforeEach(() => {
    mocks.consumerDetail.mockReset();
    useSeries.setState({ byConn: {} });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("samples the lag on every poll and charts it once there is a trend", async () => {
    mocks.consumerDetail
      .mockResolvedValueOnce(detail(10))
      .mockResolvedValue(detail(40));

    panel();
    await flush();
    expect(useSeries.getState().byConn.c?.["consumer:ORDERS:workers"]).toEqual([
      { t: expect.any(Number) as number, v: 10 },
    ]);
    expect(screen.queryByText("Lag trend")).not.toBeInTheDocument();

    await tick();
    expect(screen.getByText("Lag trend")).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Unprocessed messages, last 15 minutes",
      }),
    ).toBeInTheDocument();
    // Two polls in: the header says how little of the window is real.
    expect(screen.getByText("5s sampled")).toBeInTheDocument();
  });

  it("marks itself stale when live updates fail, keeping the last numbers", async () => {
    mocks.consumerDetail
      .mockResolvedValueOnce(detail(7))
      .mockRejectedValue(new Error("stream not found"));

    panel();
    await flush();
    await tick();

    expect(screen.getByText("stale")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });
});
