import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Workbench } from "@twigo/workbench";
import { mountKube, settle } from "../test/workbench";
import { PODS } from "./kinds";
import {
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
  const workbench = await scoped("prod-eu", ["payments"]);
  act(() => {
    workbench.spaces.update("staging", (state) => ({
      ...state,
      namespaces: ["checkout"],
    }));
    workbench.spaces.select("staging");
  });
  await settle();
  expect(workbench.spaces.active?.id).toBe("staging");

  const pod = { namespace: "payments", name: "auth-api-1" };
  const own = (space: string) => ({ ...pod, space });
  const uris = (space: string) => [
    listUri({ space, gvr: PODS }),
    objectUri({ ...own(space), gvr: PODS }),
    logsUri({ ...own(space), gvr: PODS }),
    execUri({
      space,
      namespace: "payments",
      pod: "auth-api-1",
      container: "app",
    }),
    terminalUri({ space, n: 1 }),
    untitledUri({ space, n: 1 }),
  ];
  for (const space of ["prod-eu", "staging"]) {
    for (const uri of uris(space)) {
      expect(tooltip(workbench, uri)).toMatch(new RegExp(`^${space}( › |$)`));
    }
  }
  expect(tooltip(workbench, listUri({ space: "prod-eu", gvr: PODS }))).toMatch(
    /^prod-eu › payments › /,
  );
  expect(tooltip(workbench, listUri({ space: "staging", gvr: PODS }))).toMatch(
    /^staging › checkout › /,
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
