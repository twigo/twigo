import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { IpcError } from "../error";
import type { OperationEvent, PlanRequest } from "../generated";
import { Cluster, deploymentOf } from "./cluster";
import { createMockBackend } from "./index";
import { POD_COUNT } from "./fixtures";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** The first pod of a context, as the mock backend makes the same ones. */
function pod(context: string) {
  const [first] = new Cluster(context, POD_COUNT[context] ?? 0, 0).pods;
  if (!first) throw new Error(`${context} has no pods`);
  return first;
}

function deletePod(space: string): PlanRequest {
  const { namespace, name } = pod(space);
  return {
    action: "delete",
    space,
    target: {
      gvr: { group: "", version: "v1", resource: "pods" },
      namespaced: true,
      namespace,
      name,
    },
  };
}

async function answered<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(0);
  return promise;
}

/** The error a request is refused with, caught before the timers let it reject. */
async function refused(promise: Promise<unknown>): Promise<IpcError> {
  const caught = promise.then(
    () => {
      throw new Error("it was not refused");
    },
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(0);
  const error = await caught;
  expect(error).toBeInstanceOf(IpcError);
  return error as IpcError;
}

async function run(
  backend: ReturnType<typeof createMockBackend>,
  plan: number,
  typed: string | null = null,
): Promise<OperationEvent[]> {
  const events: OperationEvent[] = [];
  await answered(
    backend.subscribe("command_execute", { plan, typed }, (event) => {
      events.push(event);
    }),
  );
  await vi.advanceTimersByTimeAsync(2000);
  return events;
}

test("a pod its replica set replaces counts down, and runs only once the countdown ends", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "qa"));
  const { name } = pod("qa");
  const plan = await answered(backend.invoke("command_plan", deletePod("qa")));
  expect(plan.friction).toEqual({ kind: "countdown", seconds: 5 });
  expect(plan.consequences[0]).toMatch(/^Its replica set .+ replaces it\.$/);
  const early = await refused(
    backend.subscribe(
      "command_execute",
      { plan: plan.id, typed: null },
      () => undefined,
    ),
  );
  expect(early.message).toBe("the countdown has not ended");

  const again = await answered(backend.invoke("command_plan", deletePod("qa")));
  await vi.advanceTimersByTimeAsync(5000);
  expect(await run(backend, again.id)).toEqual([
    { state: "running", text: `Waiting for pod ${name} to go` },
    { state: "done", text: `Deleted pod ${name}` },
  ]);
});

test("a cancelled plan never runs", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "qa"));
  const plan = await answered(backend.invoke("command_plan", deletePod("qa")));
  await answered(backend.invoke("command_cancel", plan.id));
  await vi.advanceTimersByTimeAsync(5000);
  const error = await refused(
    backend.subscribe(
      "command_execute",
      { plan: plan.id, typed: null },
      () => undefined,
    ),
  );
  expect(error.kind).toBe("notFound");
});

test("guarded asks for the context's name and read-only refuses before anything is asked", async () => {
  const backend = createMockBackend("live");
  const plan = await answered(
    backend.invoke("command_plan", deletePod("staging")),
  );
  expect(plan.friction).toEqual({ kind: "typed", text: "staging" });
  const wrong = await refused(
    backend.subscribe(
      "command_execute",
      { plan: plan.id, typed: "stagin" },
      () => undefined,
    ),
  );
  expect(wrong.message).toBe("type staging to confirm");

  const blocked = await refused(
    backend.invoke("command_plan", deletePod("prod-eu")),
  );
  expect(blocked.kind).toBe("permissions");
  expect(blocked.message).toContain(
    "prod-eu is read-only as Production by default, so Twigo did not send delete pods/",
  );
});

test("a node asks for its name typed and a deployment in a dialog", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "qa"));
  const node = await answered(
    backend.invoke("command_plan", {
      action: "delete",
      space: "qa",
      target: {
        gvr: { group: "", version: "v1", resource: "nodes" },
        namespaced: false,
        namespace: null,
        name: "qa-node-3",
      },
    }),
  );
  expect(node.friction).toEqual({ kind: "typed", text: "qa-node-3" });
  expect(node.kubectl).toBe("kubectl --context qa delete nodes qa-node-3");

  const first = pod("qa");
  const deployment = await answered(
    backend.invoke("command_plan", {
      action: "delete",
      space: "qa",
      target: {
        gvr: { group: "apps", version: "v1", resource: "deployments" },
        namespaced: true,
        namespace: first.namespace,
        name: deploymentOf(first),
      },
    }),
  );
  expect(deployment.friction).toEqual({ kind: "confirm" });
  expect(deployment.confirm).toBe("Delete deployment");
  expect(deployment.kubectl).toBe(
    `kubectl --context qa delete deployments.apps ${deploymentOf(first)} -n ${first.namespace}`,
  );
});
