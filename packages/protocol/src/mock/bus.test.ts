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
    targets: [
      {
        gvr: { group: "", version: "v1", resource: "pods" },
        namespaced: true,
        namespace,
        name,
      },
    ],
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
    { state: "done", text: `Deleted pod ${name}`, undoUntil: null },
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
      targets: [
        {
          gvr: { group: "", version: "v1", resource: "nodes" },
          namespaced: false,
          namespace: null,
          name: "qa-node-3",
        },
      ],
    }),
  );
  expect(node.friction).toEqual({ kind: "typed", text: "qa-node-3" });
  expect(node.kubectl).toBe("kubectl --context qa delete nodes qa-node-3");

  const first = pod("qa");
  const deployment = await answered(
    backend.invoke("command_plan", {
      action: "delete",
      space: "qa",
      targets: [
        {
          gvr: { group: "apps", version: "v1", resource: "deployments" },
          namespaced: true,
          namespace: first.namespace,
          name: deploymentOf(first),
        },
      ],
    }),
  );
  expect(deployment.friction).toEqual({ kind: "confirm" });
  expect(deployment.confirm).toBe("Delete deployment");
  expect(deployment.kubectl).toBe(
    `kubectl --context qa delete deployments.apps ${deploymentOf(first)} -n ${first.namespace}`,
  );
});

test("read-only refuses before the object is looked up, as Rust does", async () => {
  const backend = createMockBackend("live");
  const missing = await refused(
    backend.invoke("command_plan", {
      action: "delete",
      space: "prod-eu",
      targets: [
        {
          gvr: { group: "", version: "v1", resource: "configmaps" },
          namespaced: true,
          namespace: "payments",
          name: "no-such-map",
        },
      ],
    }),
  );
  expect(missing.kind).toBe("permissions");
});

test("a Reveal whose Secret closed before it ran fails, and says so", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "qa"));
  const object = await answered(
    backend.subscribe(
      "object_open",
      {
        object: {
          space: "qa",
          gvr: { group: "", version: "v1", resource: "secrets" },
          namespaced: true,
          namespace: "overview",
          name: "credentials",
        },
        parts: {
          overview: true,
          manifest: false,
          events: false,
          related: false,
        },
      },
      () => undefined,
    ),
  );
  const plan = await answered(
    backend.invoke("command_plan", {
      action: "reveal",
      object,
      key: "password",
    }),
  );
  expect(plan.friction).toEqual({ kind: "atOnce" });
  await answered(backend.invoke("object_close", object));
  const events = await run(backend, plan.id);
  expect(events).toEqual([
    {
      state: "failed",
      error: {
        kind: "notFound",
        message: `no object subscription ${String(object)}`,
      },
    },
  ]);
});

/** The first pod's Deployment in qa, and how many pods it has. */
function deployment() {
  const first = pod("qa");
  const name = deploymentOf(first);
  const count = new Cluster("qa", POD_COUNT.qa ?? 0, 0).pods.filter(
    (other) =>
      other.namespace === first.namespace && deploymentOf(other) === name,
  ).length;
  return {
    target: {
      gvr: { group: "apps", version: "v1", resource: "deployments" },
      namespaced: true,
      namespace: first.namespace,
      name,
    },
    name,
    namespace: first.namespace,
    count,
  };
}

test("a scale runs at once, and its undo puts it back for 30 s", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "qa"));
  const { target, name, namespace, count } = deployment();
  const scale = (replicas: number): PlanRequest => ({
    action: "scale",
    space: "qa",
    target,
    replicas,
  });
  const up = await answered(backend.invoke("command_plan", scale(count + 2)));
  expect(up.friction).toEqual({ kind: "atOnce" });
  expect(up.kubectl).toBe(
    `kubectl --context qa scale deployments.apps ${name} --replicas ${String(count + 2)} -n ${namespace}`,
  );
  const started = Date.now();
  const [done] = await run(backend, up.id);
  expect(done).toMatchObject({
    state: "done",
    text: `Scaled deployment ${name} to ${String(count + 2)}`,
  });
  const until = done?.state === "done" ? done.undoUntil : null;
  expect(until).toBeGreaterThanOrEqual(started + 30_000);
  expect(until).toBeLessThan(started + 31_000);

  const back = await answered(
    backend.invoke("command_plan", { action: "undo", space: "qa" }),
  );
  expect(back.kubectl).toBe(
    `kubectl --context qa scale deployments.apps ${name} --current-replicas ${String(count + 2)} --replicas ${String(count)} -n ${namespace}`,
  );
  expect(await run(backend, back.id)).toEqual([
    {
      state: "done",
      text: `Scaled deployment ${name} back to ${String(count)}`,
      undoUntil: null,
    },
  ]);
  const nothing = await refused(
    backend.invoke("command_plan", { action: "undo", space: "qa" }),
  );
  expect(nothing.kind).toBe("notFound");

  const same = await refused(backend.invoke("command_plan", scale(count)));
  expect(same.kind).toBe("invalidInput");
  await run(
    backend,
    (await answered(backend.invoke("command_plan", scale(count + 1)))).id,
  );
  await vi.advanceTimersByTimeAsync(30_000);
  const late = await refused(
    backend.invoke("command_plan", { action: "undo", space: "qa" }),
  );
  expect(late.kind).toBe("notFound");

  const down = await answered(backend.invoke("command_plan", scale(0)));
  expect(down.friction).toEqual({ kind: "confirm" });
  expect(down.affected[0]?.title).toBe("Its pods go");
  expect(down.affected[0]?.objects).toHaveLength(count + 1);
});

test("an undo puts back the space's last action only", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "qa"));
  const suspend = (on: boolean): PlanRequest => ({
    action: "suspend",
    space: "qa",
    target: {
      gvr: { group: "batch", version: "v1", resource: "cronjobs" },
      namespaced: true,
      namespace: "batch",
      name: "report",
    },
    suspend: on,
  });
  const plan = await answered(backend.invoke("command_plan", suspend(true)));
  expect(plan.friction).toEqual({ kind: "atOnce" });
  await run(backend, plan.id);
  await run(
    backend,
    (await answered(backend.invoke("command_plan", suspend(false)))).id,
  );
  await run(
    backend,
    (await answered(backend.invoke("command_plan", suspend(true)))).id,
  );
  const undo = await answered(
    backend.invoke("command_plan", { action: "undo", space: "qa" }),
  );
  expect(await run(backend, undo.id)).toEqual([
    {
      state: "done",
      text: "Resumed cron job report",
      undoUntil: null,
    },
  ]);
});

test("a drain cordons the node and lists the pods it evicts", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "qa"));
  const node = pod("qa").node;
  const plan = await answered(
    backend.invoke("command_plan", { action: "drain", space: "qa", node }),
  );
  expect(plan.friction).toEqual({ kind: "confirm" });
  expect(plan.kubectl).toBe(
    `kubectl --context qa drain ${node} --ignore-daemonsets`,
  );
  expect(plan.affected[0]?.objects.map((object) => object.name)).toContain(
    pod("qa").name,
  );
  const events = await run(backend, plan.id);
  expect(events[events.length - 1]).toEqual({
    state: "done",
    text: `Drained node ${node}`,
    undoUntil: null,
  });
  const again = await refused(
    backend.invoke("command_plan", {
      action: "cordon",
      space: "qa",
      node,
      unschedulable: true,
    }),
  );
  expect(again.message).toBe(`Node ${node} is cordoned already`);
});

test("a trigger asks in a dialog and names the job it makes", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "qa"));
  const plan = await answered(
    backend.invoke("command_plan", {
      action: "trigger",
      space: "qa",
      namespace: "batch",
      name: "report",
    }),
  );
  expect(plan.friction).toEqual({ kind: "confirm" });
  const job = /^Job (\S+) runs once/.exec(plan.consequences[0] ?? "")?.[1];
  expect(job).toMatch(/^report-manual-[bcdfghjklmnpqrstvwxz2456789]{5}$/);
  expect(plan.kubectl).toBe(
    `kubectl --context qa create job ${job ?? ""} --from cronjob/report -n batch`,
  );
  expect(await run(backend, plan.id)).toEqual([
    { state: "done", text: `Created job ${job ?? ""}`, undoUntil: null },
  ]);
});

test("a delete of several asks for the context's name typed and lists them", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "qa"));
  const pods = new Cluster("qa", POD_COUNT.qa ?? 0, 0).pods.slice(0, 3);
  const plan = await answered(
    backend.invoke("command_plan", {
      action: "delete",
      space: "qa",
      targets: pods.map((each) => ({
        gvr: { group: "", version: "v1", resource: "pods" },
        namespaced: true,
        namespace: each.namespace,
        name: each.name,
      })),
    }),
  );
  expect(plan.friction).toEqual({ kind: "typed", text: "qa" });
  expect(plan.confirm).toBe("Delete 3 pods");
  expect(plan.affected[0]).toEqual({
    title: "Deletes",
    objects: pods.map((each) => ({
      group: "",
      version: "v1",
      kind: "Pod",
      namespace: each.namespace,
      name: each.name,
    })),
  });
});

test("a viewer may read and nothing else", async () => {
  const checks = ["list", "delete", "patch"].map((verb) => ({
    verb,
    group: "",
    resource: "pods",
    subresource: null,
  }));
  const viewer = createMockBackend("viewer");
  expect(
    await answered(
      viewer.invoke("access_review", { space: "qa", namespace: null, checks }),
    ),
  ).toEqual([true, false, false]);
  const admin = createMockBackend("live");
  expect(
    await answered(
      admin.invoke("access_review", { space: "qa", namespace: null, checks }),
    ),
  ).toEqual([true, true, true]);
});
