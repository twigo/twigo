import { expect, test } from "vitest";
import type { Forward, ForwardState } from "@twigo/protocol";
import { forwardKeys } from "./keys";
import {
  addressOf,
  forwardTitle,
  portWords,
  stateOf,
  targetWords,
  webOf,
  webUrl,
} from "./words";

function forward(more: Partial<Forward> = {}): Forward {
  return {
    id: 1,
    target: {
      space: "dev",
      gvr: { group: "", version: "v1", resource: "services" },
      namespace: "default",
      name: "web",
    },
    kind: "Service",
    port: 80,
    portName: "http",
    local: 8080,
    addresses: ["127.0.0.1", "::1"],
    state: { state: "ready" },
    pod: null,
    podPort: null,
    connections: 0,
    queued: 0,
    sent: 0,
    received: 0,
    failure: null,
    ...more,
  };
}

test("a forward is named by its target and port, and reached on localhost", () => {
  const web = forward();
  expect(targetWords(web)).toBe("web:http");
  expect(forwardTitle(web)).toBe("web:http → 8080");
  expect(portWords(web)).toBe("http 80");
  expect(addressOf(web)).toBe("localhost:8080");
  const unnamed = forward({ portName: null, port: 9000, local: 9001 });
  expect(targetWords(unnamed)).toBe("web:9000");
  expect(forwardTitle(unnamed)).toBe("web:9000 → 9001");
  expect(portWords(unnamed)).toBe("9000");
});

test.each<[string, number, "http" | "https" | undefined]>([
  ["http", 80, "http"],
  ["web", 3000, "http"],
  ["http-alt", 8081, "http"],
  ["admin-http", 9000, "http"],
  ["https", 443, "https"],
  ["web-https", 8443, "https"],
  ["grpc", 8080, undefined],
  ["grpc-tls", 443, undefined],
  ["metrics", 9090, undefined],
  ["webhook", 9443, undefined],
])("a port named %s at %i opens as %s", (portName, port, scheme) => {
  expect(webOf(forward({ portName, port }))).toBe(scheme);
});

test.each<[number, "http" | "https" | undefined]>([
  [80, "http"],
  [8080, "http"],
  [443, "https"],
  [8443, "https"],
  [5432, undefined],
  [9090, undefined],
])("a port with no name at %i opens as %s", (port, scheme) => {
  expect(webOf(forward({ portName: null, port }))).toBe(scheme);
});

test("the link to a web port uses the local port and its scheme", () => {
  expect(webUrl(forward({ local: 8090 }))).toBe("http://localhost:8090");
  expect(webUrl(forward({ portName: "https", local: 8443 }))).toBe(
    "https://localhost:8443",
  );
  expect(webUrl(forward({ portName: "grpc" }))).toBeUndefined();
});

test.each<[ForwardState, string, string, boolean]>([
  [{ state: "starting" }, "Starting", "idle", true],
  [{ state: "restored" }, "Restored", "idle", false],
  [{ state: "ready" }, "Ready", "ok", false],
  [{ state: "reconnecting", reason: "no pod" }, "Reconnecting", "warn", true],
  [
    { state: "failed", error: { kind: "notFound", message: "gone" } },
    "Failed",
    "error",
    false,
  ],
  [{ state: "stopped" }, "Stopped", "idle", false],
])("%o is %s, in the %s tone", (state, label, tone, pulse) => {
  const shown = stateOf(forward({ state }));
  expect(shown).toMatchObject({ label, tone });
  expect(shown.pulse === true).toBe(pulse);
});

test("a reason or a failure is the state's detail, and waiting connections turn a ready forward to a warning", () => {
  expect(
    stateOf(forward({ state: { state: "reconnecting", reason: "no pod" } }))
      .detail,
  ).toBe("no pod");
  expect(
    stateOf(
      forward({
        state: {
          state: "failed",
          error: { kind: "notFound", message: "gone" },
        },
      }),
    ).detail,
  ).toBe("gone");
  expect(stateOf(forward({ queued: 2 }))).toEqual({
    label: "Ready · 2 waiting",
    tone: "warn",
  });
});

test("a forward that the context's mode refuses says the mode, as a warning, and not that it failed", () => {
  const blocked = forward({
    state: {
      state: "failed",
      error: {
        kind: "permissions",
        message:
          "dev is read-only by dev in policy.json, so Twigo did not send create pods/x/portforward in ns",
        blocked: {
          context: "dev",
          mode: "read-only",
          source: { kind: "policyFile", file: "policy.json", pattern: "dev" },
          class: "forward",
          reason: "mode",
          verb: "create",
          target: "pods/x/portforward in ns",
        },
      },
    },
  });
  expect(stateOf(blocked)).toEqual({
    label: "Read-only",
    tone: "warn",
    detail:
      "dev is read-only by dev in policy.json, so Twigo did not send create pods/x/portforward in ns",
  });
});

test("what a state lets be done is what the forward's keys say", () => {
  const keys = (state: ForwardState) =>
    forwardKeys(forward({ state, portName: "grpc" }));
  expect(keys({ state: "ready" })).toEqual({
    forward: true,
    "forward.running": true,
    "forward.startable": false,
    "forward.web": false,
  });
  expect(keys({ state: "stopped" })).toMatchObject({
    "forward.running": false,
    "forward.startable": true,
  });
  expect(
    keys({ state: "failed", error: { kind: "internal", message: "x" } }),
  ).toMatchObject({ "forward.running": true, "forward.startable": true });
  expect(forwardKeys(forward())["forward.web"]).toBe(true);
});
