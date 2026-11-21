import { expect, test } from "vitest";
import {
  INITIAL_LOGS,
  type LogPod,
  type LogsSnapshot,
  type StreamState,
} from "@twigo/protocol";
import { logsState } from "./state";

const pod = (...streams: StreamState[]): LogPod => ({
  name: "api-0",
  generated: null,
  status: "Running",
  tone: "neutral",
  containers: streams.map((stream, at) => ({
    name: `container-${String(at)}`,
    stream,
  })),
});

const snapshot = (more: Partial<LogsSnapshot>): LogsSnapshot => ({
  ...INITIAL_LOGS,
  status: { state: "ready" },
  ...more,
});

const BROKEN: StreamState = {
  state: "error",
  error: { code: "connect.other", kind: "unavailable", message: "broken" },
};

test("a logs tab says connecting until its pods are known, and running for a workload that has none yet", () => {
  expect(logsState(INITIAL_LOGS)).toBe("connecting");
  expect(logsState(snapshot({ pods: undefined }))).toBe("connecting");
  expect(logsState(snapshot({ pods: [] }))).toBe("running");
});

test("a logs tab says failed while its target is down, whatever its streams were", () => {
  const pods = [pod({ state: "following" })];
  for (const status of [
    { state: "forbidden", verb: "get", resource: "pods/log" },
    { state: "unauthorized" },
    {
      state: "error",
      error: { code: "connect.other", kind: "unavailable", message: "broken" },
    },
  ] as const) {
    expect(logsState(snapshot({ status, pods }))).toBe("failed");
  }
  expect(logsState(snapshot({ status: { state: "stale" }, pods }))).toBe(
    "running",
  );
});

test("a logs tab says what its streams say together: running while one reads, connecting while one starts, else failed if one failed, else ended", () => {
  const of = (...streams: StreamState[]) =>
    logsState(snapshot({ pods: [pod(...streams)] }));
  expect(of({ state: "ended" }, { state: "following" })).toBe("running");
  expect(of({ state: "connecting" }, { state: "waiting", reason: null })).toBe(
    "running",
  );
  expect(of({ state: "ended" }, { state: "queued" })).toBe("connecting");
  expect(of(BROKEN, { state: "connecting" })).toBe("connecting");
  expect(of({ state: "ended" }, BROKEN)).toBe("failed");
  expect(of({ state: "ended" }, { state: "off" })).toBe("ended");
  expect(of({ state: "overLimit" })).toBe("ended");
});
