import { act } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { Backend, Discovered, Resource } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { Changes } from "@twigo/workbench";
import { testWorkbench } from "@twigo/workbench/testing";
import RESOURCES from "../../protocol/src/mock/resources.json";
import { Discovery } from "./discovery";

const PODS: readonly Resource[] = RESOURCES.filter(
  (resource) => resource.gvr.resource === "pods",
);

async function following() {
  const mock = createMockBackend("ready");
  const watched: string[] = [];
  const pushes = new Map<string, (next: Discovered) => void>();
  const backend: Backend = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe: (command, request, onMessage) => {
      if (command === "resources_watch" && typeof request === "string") {
        watched.push(request);
        pushes.set(request, onMessage);
      }
      return mock.subscribe(command, request, onMessage);
    },
  };
  const workbench = await testWorkbench("ready", backend);
  const credentials = { changes: new Changes(), ready: 0 };
  const discovery = new Discovery({
    backend,
    spaces: workbench.spaces,
    credentials,
  });
  const push = (space: string, next: Discovered) => {
    act(() => {
      pushes.get(space)?.(next);
    });
  };
  return { workbench, credentials, discovery, watched, push };
}

test("the active space's resources come, then each change of them", async () => {
  const { discovery, watched, push } = await following();
  expect(watched).toEqual(["prod-eu"]);
  await expect(discovery.resources("prod-eu")).resolves.toEqual(RESOURCES);

  push("prod-eu", { state: "ready", resources: [...PODS] });
  expect(discovery.get("prod-eu")).toEqual({ state: "ready", value: PODS });
});

test("another space is followed once active, and the one before keeps its answer", async () => {
  const { workbench, discovery, watched } = await following();
  await discovery.resources("prod-eu");
  expect(discovery.get("staging").state).toBe("loading");

  act(() => {
    workbench.spaces.select("staging");
  });
  await expect(discovery.resources("staging")).resolves.toEqual(RESOURCES);
  expect(watched).toEqual(["prod-eu", "staging"]);
  expect(discovery.get("prod-eu").state).toBe("ready");
});

test("a failed discovery asks again once a credential comes", async () => {
  const { credentials, discovery, watched, push } = await following();
  await discovery.resources("prod-eu");
  push("prod-eu", {
    state: "failed",
    error: { kind: "unauthorized", message: "no credentials" },
  });
  await expect(discovery.resources("prod-eu")).rejects.toMatchObject({
    kind: "unauthorized",
  });

  credentials.ready++;
  act(() => {
    credentials.changes.emit();
  });
  await vi.waitFor(() => {
    expect(discovery.get("prod-eu").state).toBe("ready");
  });
  expect(watched).toEqual(["prod-eu", "prod-eu"]);
});

test("a change sent before the answer outlives the answer", async () => {
  const mock = createMockBackend("ready");
  const backend: Backend = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe: (command, request, onMessage) => {
      const answer = mock.subscribe(command, request, onMessage);
      if (command === "resources_watch") {
        onMessage({ state: "ready", resources: [...PODS] });
      }
      return answer;
    },
  };
  const workbench = await testWorkbench("ready", backend);
  const discovery = new Discovery({
    backend,
    spaces: workbench.spaces,
    credentials: { changes: new Changes(), ready: 0 },
  });
  await vi.waitFor(() => {
    expect(discovery.get("prod-eu")).toEqual({ state: "ready", value: PODS });
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(discovery.get("prod-eu")).toEqual({ state: "ready", value: PODS });
});
