import { expect, test } from "vitest";
import type { Forward, ForwardState, ModeSource } from "@twigo/protocol";
import { forwardKeys } from "./keys";
import {
  addressOf,
  forwardTitle,
  listensOn,
  localWords,
  portLabel,
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
    appProtocol: null,
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
  expect(portLabel(web)).toBe("http");
  expect(localWords(web)).toBe("→ 8080");
  expect(targetWords(web)).toBe("web:http");
  expect(forwardTitle(web)).toBe("web:http → 8080");
  expect(portWords(web)).toBe("http 80");
  expect(addressOf(web)).toBe("localhost:8080");
  const unnamed = forward({ portName: null, port: 9000, local: 9001 });
  expect(portLabel(unnamed)).toBe("9000");
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

test.each<[string, string | null, number, "http" | "https" | undefined]>([
  ["http", null, 9999, "http"],
  ["https", null, 9999, "https"],
  ["HTTP", null, 9999, "http"],
  ["https", "web", 8080, "https"],
  ["http", "grpc", 50051, "http"],
  ["grpc", "http", 80, undefined],
  ["kubernetes.io/ws", "http", 8080, undefined],
  ["kubernetes.io/h2c", null, 8080, undefined],
  ["mycompany.com/my-custom-protocol", "web", 8080, undefined],
])(
  "an appProtocol %s on a port named %s at %i decides: it opens as %s",
  (appProtocol, portName, port, scheme) => {
    expect(webOf(forward({ appProtocol, portName, port }))).toBe(scheme);
  },
);

test("the link to a web port uses the local port and its scheme", () => {
  expect(webUrl(forward({ local: 8090 }))).toBe("http://localhost:8090");
  expect(webUrl(forward({ portName: "https", local: 8443 }))).toBe(
    "https://localhost:8443",
  );
  expect(webUrl(forward({ portName: "grpc" }))).toBeUndefined();
  expect(
    webUrl(
      forward({
        appProtocol: "https",
        portName: null,
        port: 9999,
        local: 9443,
      }),
    ),
  ).toBe("https://localhost:9443");
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

const REFUSED = (source: ModeSource): ForwardState => ({
  state: "failed",
  error: {
    kind: "permissions",
    message:
      "dev is read-only, so Twigo did not send get pods/x/portforward in ns",
    blocked: {
      context: "dev",
      mode: "read-only",
      source,
      class: "forward",
      reason: "mode",
      verb: "get",
      target: "pods/x/portforward in ns",
    },
  },
});
const FAILED: ForwardState = {
  state: "failed",
  error: { kind: "internal", message: "x" },
};
const RECONNECTING: ForwardState = { state: "reconnecting", reason: "no pod" };

test.each<
  [
    string,
    Partial<Forward>,
    { running: boolean; startable: boolean; movable: boolean; web: boolean },
  ]
>([
  [
    "ready",
    { state: { state: "ready" } },
    { running: true, startable: false, movable: true, web: true },
  ],
  [
    "starting",
    { state: { state: "starting" } },
    { running: true, startable: false, movable: true, web: true },
  ],
  [
    "restored",
    { state: { state: "restored" } },
    { running: true, startable: false, movable: true, web: true },
  ],
  [
    "reconnecting, which Start asks again",
    { state: RECONNECTING },
    { running: true, startable: true, movable: true, web: true },
  ],
  [
    "stopped, which listens nowhere",
    { state: { state: "stopped" } },
    { running: false, startable: true, movable: true, web: false },
  ],
  [
    "stopped in this session, whose addresses the core keeps",
    { state: { state: "stopped" }, addresses: ["127.0.0.1"] },
    { running: false, startable: true, movable: true, web: false },
  ],
  [
    "failed, still listening",
    { state: FAILED },
    { running: true, startable: true, movable: true, web: false },
  ],
  [
    "failed, listening nowhere",
    { state: FAILED, addresses: [] },
    { running: true, startable: true, movable: true, web: false },
  ],
  [
    "restored, its port held at the restore, so it listens nowhere",
    { state: { state: "restored" }, addresses: [] },
    { running: true, startable: false, movable: true, web: false },
  ],
  [
    "refused by a lock the person may lift",
    { state: REFUSED({ kind: "user" }) },
    { running: true, startable: true, movable: true, web: false },
  ],
  [
    "refused by a policy file, which no one here lifts",
    {
      state: REFUSED({
        kind: "policyFile",
        file: "policy.json",
        pattern: null,
      }),
    },
    { running: true, startable: false, movable: false, web: false },
  ],
  [
    "refused for a context no source lists",
    { state: REFUSED({ kind: "unlisted" }) },
    { running: true, startable: false, movable: false, web: false },
  ],
])("the keys of a forward that is %s", (_name, more, expected) => {
  expect(forwardKeys(forward({ portName: "http", ...more }))).toEqual({
    forward: true,
    "forward.running": expected.running,
    "forward.startable": expected.startable,
    "forward.movable": expected.movable,
    "forward.web": expected.web,
  });
});

test("a port that does not say HTTP has no web key, and the forward's own appProtocol decides", () => {
  const web = (more: Partial<Forward>) =>
    forwardKeys(forward(more))["forward.web"];
  expect(web({ portName: "grpc" })).toBe(false);
  expect(web({})).toBe(true);
  expect(web({ portName: null, port: 9999, appProtocol: "http" })).toBe(true);
  expect(web({ appProtocol: "grpc" })).toBe(false);
});

test("a forward listens on its addresses unless it is stopped or the core bound none", () => {
  const both = ["127.0.0.1", "::1"];
  expect(listensOn(forward())).toEqual(both);
  expect(listensOn(forward({ state: { state: "stopped" } }))).toEqual([]);
  expect(listensOn(forward({ addresses: [] }))).toEqual([]);
  expect(listensOn(forward({ state: FAILED }))).toEqual(both);
});
