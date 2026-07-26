import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MetricsSection } from "./MetricsSection";
import type { Sample } from "@/store/monitor";

function sample(t: number, over: Partial<Sample> = {}): Sample {
  return {
    t,
    inMsgs: 0,
    outMsgs: 0,
    inBytes: 0,
    outBytes: 0,
    connections: 0,
    subscriptions: 0,
    slowConsumers: 0,
    mem: 0,
    cpu: 0,
    ...over,
  };
}

const SAMPLES = [
  sample(0, { inMsgs: 0, connections: 2 }),
  sample(1000, { inMsgs: 40, connections: 3 }),
];

describe("MetricsSection", () => {
  afterEach(cleanup);

  it("says it is still collecting rather than drawing empty charts", () => {
    render(<MetricsSection samples={[sample(0)]} />);
    expect(screen.getByText(/Collecting samples/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("charts every metric once there are samples", () => {
    render(<MetricsSection samples={SAMPLES} />);

    expect(screen.getAllByRole("img")).toHaveLength(6);
    expect(screen.getByText("40/s")).toBeInTheDocument();
  });

  it("keeps the axis on the window and says how much of it is real", () => {
    render(<MetricsSection samples={SAMPLES} />);

    // A second of history under a 15m window: the axis stays 15m, so the line
    // sits where it belongs in time - and the header owns up to the emptiness.
    expect(
      screen.getByRole("img", { name: "Throughput, last 15m" }),
    ).toBeInTheDocument();
    expect(screen.getByText("1s sampled")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "1h" }));
    expect(
      screen.getByRole("img", { name: "Throughput, last 1h" }),
    ).toBeInTheDocument();
  });

  it("collapses to its header", () => {
    render(<MetricsSection samples={SAMPLES} />);

    fireEvent.click(screen.getByRole("button", { name: /Metrics/ }));

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
