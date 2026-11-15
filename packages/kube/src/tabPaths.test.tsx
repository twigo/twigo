import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Backend } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import type { Workbench } from "@twigo/workbench";
import { mountKube, settle } from "../test/workbench";
import { PODS } from "./kinds";
import {
  diffUri,
  execUri,
  listUri,
  logsUri,
  objectUri,
  terminalUri,
  untitledUri,
} from "./uri";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const tooltip = (workbench: Workbench, uri: string) =>
  workbench.editors.resolve(uri)?.tooltip?.(new URL(uri));

const NODES = { group: "", version: "v1", resource: "nodes" };
const DEPLOYMENTS = { group: "apps", version: "v1", resource: "deployments" };

async function scoped(space: string, namespaces: readonly string[]) {
  const workbench = await mountKube();
  act(() => {
    workbench.spaces.update(space, (state) => ({ ...state, namespaces }));
  });
  return workbench;
}

test("each kind of tab says where it is in one order: context, namespace, kind, object", async () => {
  const workbench = await scoped("prod-eu", ["payments"]);
  const pods = listUri({ space: "prod-eu", gvr: PODS });
  const nodes = listUri({ space: "prod-eu", gvr: NODES });
  const pinned = listUri({
    space: "prod-eu",
    gvr: PODS,
    namespaces: ["checkout", "ledger"],
  });
  act(() => {
    workbench.editors.open(pods);
    workbench.editors.open(nodes);
    workbench.editors.open(pinned);
  });
  await settle();

  expect(tooltip(workbench, pods)).toBe("prod-eu › payments › Pods");
  expect(tooltip(workbench, pinned)).toBe("prod-eu › checkout, ledger › Pods");
  expect(tooltip(workbench, nodes)).toBe("prod-eu › Nodes");
  act(() => {
    workbench.spaces.update("prod-eu", (state) => ({
      ...state,
      namespaces: [],
    }));
  });
  expect(tooltip(workbench, pods)).toBe("prod-eu › All namespaces › Pods");

  const pod = { space: "prod-eu", namespace: "payments", name: "auth-api-1" };
  expect(tooltip(workbench, objectUri({ ...pod, gvr: PODS }))).toBe(
    "prod-eu › payments › Pod › auth-api-1",
  );
  expect(
    tooltip(workbench, objectUri({ space: "prod-eu", gvr: NODES, name: "n1" })),
  ).toBe("prod-eu › Node › n1");
  expect(tooltip(workbench, logsUri({ ...pod, gvr: PODS }))).toBe(
    "prod-eu › payments › Pod › auth-api-1",
  );
  expect(
    tooltip(workbench, logsUri({ ...pod, gvr: DEPLOYMENTS, name: "auth-api" })),
  ).toBe("prod-eu › payments › Deployment › auth-api");
  expect(
    tooltip(
      workbench,
      execUri({
        space: "prod-eu",
        namespace: "payments",
        pod: "auth-api-1",
        container: "app",
      }),
    ),
  ).toBe("prod-eu › payments › Pod › auth-api-1 › app");
  expect(tooltip(workbench, terminalUri({ space: "prod-eu", n: 1 }))).toBe(
    "prod-eu",
  );
  expect(tooltip(workbench, untitledUri({ space: "prod-eu", n: 1 }))).toBe(
    "prod-eu",
  );
});

test("a tooltip names its own space's context and scope, never the active space's", async () => {
  const mock = createMockBackend("ready");
  const spaces = [
    { id: "s1", name: "payments", contexts: ["prod-eu"] },
    { id: "s2", name: "checkout", contexts: ["staging"] },
  ];
  const backend = {
    invoke: (command: string, request: unknown) =>
      command === "spaces_list"
        ? Promise.resolve(spaces)
        : (mock.invoke as (...args: unknown[]) => unknown)(command, request),
    subscribe: mock.subscribe.bind(mock),
  } as Backend;
  const workbench = await mountKube(backend);
  act(() => {
    workbench.spaces.update("s1", (state) => ({
      ...state,
      namespaces: ["payments"],
    }));
    workbench.spaces.update("s2", (state) => ({
      ...state,
      namespaces: ["checkout"],
    }));
    workbench.spaces.select("s2");
  });
  await settle();
  expect(workbench.spaces.active?.id).toBe("s2");

  const uris = (space: string) => [
    listUri({ space, gvr: PODS }),
    objectUri({ space, gvr: PODS, namespace: "payments", name: "auth-api-1" }),
    logsUri({ space, gvr: PODS, namespace: "payments", name: "auth-api-1" }),
    execUri({
      space,
      namespace: "payments",
      pod: "auth-api-1",
      container: "app",
    }),
    terminalUri({ space, n: 1 }),
    untitledUri({ space, n: 1 }),
  ];
  for (const [space, context] of [
    ["s1", "prod-eu"],
    ["s2", "staging"],
  ] as const) {
    for (const uri of uris(space)) {
      expect(tooltip(workbench, uri)).toMatch(new RegExp(`^${context}( › |$)`));
    }
  }
  expect(tooltip(workbench, listUri({ space: "s1", gvr: PODS }))).toMatch(
    /^prod-eu › payments › /,
  );
  expect(tooltip(workbench, listUri({ space: "s2", gvr: PODS }))).toMatch(
    /^staging › checkout › /,
  );
});

test("a diff tab says the path of what it compares, both sides for two objects", async () => {
  const workbench = await mountKube();
  const pod = (name: string) =>
    objectUri({ space: "prod-eu", gvr: PODS, namespace: "payments", name });
  const manifest = untitledUri({ space: "prod-eu", n: 1 });

  expect(
    tooltip(workbench, diffUri({ kind: "server", editor: pod("auth-api-1") })),
  ).toBe("prod-eu › payments › Pod › auth-api-1");
  expect(tooltip(workbench, diffUri({ kind: "apply", editor: manifest }))).toBe(
    "prod-eu",
  );
  expect(
    tooltip(
      workbench,
      diffUri({
        kind: "objects",
        space: "prod-eu",
        left: pod("auth-api-1"),
        right: pod("auth-api-2"),
      }),
    ),
  ).toBe(
    "prod-eu › payments › Pod › auth-api-1 ↔ prod-eu › payments › Pod › auth-api-2",
  );
});

test("a tab of a space that is gone says nothing rather than guess a context", async () => {
  const workbench = await mountKube();
  expect(
    tooltip(
      workbench,
      objectUri({ space: "gone", gvr: PODS, namespace: "a", name: "b" }),
    ),
  ).toBeUndefined();
});
