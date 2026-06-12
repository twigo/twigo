import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listStreams: vi.fn(),
  listConsumers: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  jsListStreams: mocks.listStreams,
  jsListConsumers: mocks.listConsumers,
}));

import { useJetStream } from "./jetstream";

function stream(name: string) {
  return {
    name,
    subjects: [`${name}.>`],
    messages: 0,
    bytes: 0,
    firstSeq: 0,
    lastSeq: 0,
    consumerCount: 0,
    storage: "file",
    retention: "limits",
  };
}
function consumer(name: string) {
  return {
    name,
    durable: true,
    kind: "pull",
    ackPolicy: "explicit",
    numPending: 0,
    numAckPending: 0,
    numRedelivered: 0,
    paused: false,
  };
}

describe("jetstream store", () => {
  beforeEach(() => {
    mocks.listStreams.mockReset();
    mocks.listConsumers.mockReset();
    useJetStream.setState({ byConn: {} });
  });

  it("loads streams for a connection", async () => {
    mocks.listStreams.mockResolvedValue([stream("ORDERS"), stream("EVENTS")]);
    await useJetStream.getState().load("dev");
    const s = useJetStream.getState().byConn.dev;
    expect(s?.status).toBe("ready");
    expect(s?.parents.map((x) => x.name)).toEqual(["ORDERS", "EVENTS"]);
  });

  it("records an error status on load failure", async () => {
    mocks.listStreams.mockRejectedValue(new Error("no JS"));
    await useJetStream.getState().load("dev");
    expect(useJetStream.getState().byConn.dev?.status).toBe("error");
  });

  it("lazily loads consumers on first expand, and caches them", async () => {
    mocks.listStreams.mockResolvedValue([stream("ORDERS")]);
    mocks.listConsumers.mockResolvedValue([consumer("worker")]);
    await useJetStream.getState().load("dev");

    await useJetStream.getState().toggle("dev", "ORDERS");
    const s = useJetStream.getState().byConn.dev;
    expect(s?.expanded.ORDERS).toBe(true);
    expect(s?.children.ORDERS?.[0]?.name).toBe("worker");
    expect(mocks.listConsumers).toHaveBeenCalledTimes(1);

    // Collapse then re-expand: no refetch (consumers are cached).
    await useJetStream.getState().toggle("dev", "ORDERS");
    await useJetStream.getState().toggle("dev", "ORDERS");
    expect(mocks.listConsumers).toHaveBeenCalledTimes(1);
  });

  it("reset drops a connection's jetstream state", async () => {
    mocks.listStreams.mockResolvedValue([stream("ORDERS")]);
    await useJetStream.getState().load("dev");
    useJetStream.getState().reset("dev");
    expect(useJetStream.getState().byConn.dev).toBeUndefined();
  });
});
