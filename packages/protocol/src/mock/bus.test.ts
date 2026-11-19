import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { IpcError } from "../error";
import type {
  Environment,
  Mode,
  OperationEvent,
  PlanRequest,
} from "../generated";
import { Cluster, deploymentOf } from "./cluster";
import { createMockBackend, protect } from "./index";
import { POD_COUNT, UNMARKED } from "./fixtures";

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

type Protection = Parameters<typeof protect>[1];

const tick = () => vi.advanceTimersByTimeAsync(1);

function change(
  backend: ReturnType<typeof createMockBackend>,
  request: Protection,
): Promise<void> {
  return protect(backend, request, tick);
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
  await answered(backend.invoke("space_open", "kind-local"));
  const { name } = pod("kind-local");
  const plan = await answered(
    backend.invoke("command_plan", deletePod("kind-local")),
  );
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

  const again = await answered(
    backend.invoke("command_plan", deletePod("kind-local")),
  );
  await vi.advanceTimersByTimeAsync(5000);
  expect(await run(backend, again.id)).toEqual([
    { state: "running", text: `Waiting for pod ${name} to go` },
    { state: "done", text: `Deleted pod ${name}`, undoUntil: null },
  ]);
});

test("a cancelled plan never runs", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "kind-local"));
  const plan = await answered(
    backend.invoke("command_plan", deletePod("kind-local")),
  );
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
  await answered(backend.invoke("space_open", "kind-local"));
  const node = await answered(
    backend.invoke("command_plan", {
      action: "delete",
      space: "kind-local",
      targets: [
        {
          gvr: { group: "", version: "v1", resource: "nodes" },
          namespaced: false,
          namespace: null,
          name: "kind-local-node-3",
        },
      ],
    }),
  );
  expect(node.friction).toEqual({ kind: "typed", text: "kind-local-node-3" });
  expect(node.kubectl).toBe(
    "kubectl --context kind-local delete nodes kind-local-node-3",
  );

  const first = pod("kind-local");
  const deployment = await answered(
    backend.invoke("command_plan", {
      action: "delete",
      space: "kind-local",
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
    `kubectl --context kind-local delete deployments.apps ${deploymentOf(first)} -n ${first.namespace}`,
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
  await answered(backend.invoke("space_open", "kind-local"));
  const object = await answered(
    backend.subscribe(
      "object_open",
      {
        object: {
          space: "kind-local",
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
          usage: false,
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

function deployment() {
  const first = pod("kind-local");
  const name = deploymentOf(first);
  const count = new Cluster(
    "kind-local",
    POD_COUNT["kind-local"] ?? 0,
    0,
  ).pods.filter(
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
  await answered(backend.invoke("space_open", "kind-local"));
  const { target, name, namespace, count } = deployment();
  const scale = (replicas: number): PlanRequest => ({
    action: "scale",
    space: "kind-local",
    target,
    replicas,
  });
  const up = await answered(backend.invoke("command_plan", scale(count + 2)));
  expect(up.friction).toEqual({ kind: "atOnce" });
  expect(up.kubectl).toBe(
    `kubectl --context kind-local scale deployments.apps ${name} --current-replicas ${String(count)} --replicas ${String(count + 2)} -n ${namespace}`,
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
    backend.invoke("command_plan", { action: "undo", space: "kind-local" }),
  );
  expect(back.kubectl).toBe(
    `kubectl --context kind-local scale deployments.apps ${name} --current-replicas ${String(count + 2)} --replicas ${String(count)} -n ${namespace}`,
  );
  expect(await run(backend, back.id)).toEqual([
    {
      state: "done",
      text: `Scaled deployment ${name} back to ${String(count)}`,
      undoUntil: null,
    },
  ]);
  const nothing = await refused(
    backend.invoke("command_plan", { action: "undo", space: "kind-local" }),
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
    backend.invoke("command_plan", { action: "undo", space: "kind-local" }),
  );
  expect(late.kind).toBe("notFound");

  const down = await answered(backend.invoke("command_plan", scale(0)));
  expect(down.friction).toEqual({ kind: "confirm" });
  expect(down.affected[0]?.title).toBe("Its pods go");
  expect(down.affected[0]?.objects).toHaveLength(count + 1);
});

test("an undo puts back the space's last action only", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "kind-local"));
  const suspend = (on: boolean): PlanRequest => ({
    action: "suspend",
    space: "kind-local",
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
    backend.invoke("command_plan", { action: "undo", space: "kind-local" }),
  );
  expect(await run(backend, undo.id)).toEqual([
    {
      state: "done",
      text: "Resumed cron job report",
      undoUntil: null,
    },
  ]);
});

test("the last action is the one that started last, whichever ends first", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "kind-local"));
  const [drained, cordoned] = ["kind-local-node-3", "kind-local-node-4"];
  const drain = await answered(
    backend.invoke("command_plan", {
      action: "drain",
      space: "kind-local",
      node: drained,
    }),
  );
  await answered(
    backend.subscribe(
      "command_execute",
      { plan: drain.id, typed: null },
      () => undefined,
    ),
  );
  const cordon = await answered(
    backend.invoke("command_plan", {
      action: "cordon",
      space: "kind-local",
      node: cordoned,
      unschedulable: true,
    }),
  );
  await run(backend, cordon.id);
  const undo = await answered(
    backend.invoke("command_plan", { action: "undo", space: "kind-local" }),
  );
  expect(undo.question).toBe(`Uncordon node ${cordoned} on kind-local?`);

  const first = await answered(
    backend.invoke("command_plan", {
      action: "cordon",
      space: "kind-local",
      node: drained,
      unschedulable: false,
    }),
  );
  const later = await answered(
    backend.invoke("command_plan", {
      action: "drain",
      space: "kind-local",
      node: cordoned,
    }),
  );
  const both = [first, later].map((plan) =>
    backend.subscribe(
      "command_execute",
      { plan: plan.id, typed: null },
      () => undefined,
    ),
  );
  await answered(Promise.all(both));
  await vi.advanceTimersByTimeAsync(2000);
  const nothing = await refused(
    backend.invoke("command_plan", { action: "undo", space: "kind-local" }),
  );
  expect(nothing.kind).toBe("notFound");
});

test("an undo that scales back to zero asks and lists the pods that go", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "kind-local"));
  const { target } = deployment();
  const scale = (replicas: number): PlanRequest => ({
    action: "scale",
    space: "kind-local",
    target,
    replicas,
  });
  await run(
    backend,
    (await answered(backend.invoke("command_plan", scale(0)))).id,
  );
  await run(
    backend,
    (await answered(backend.invoke("command_plan", scale(2)))).id,
  );
  const undo = await answered(
    backend.invoke("command_plan", { action: "undo", space: "kind-local" }),
  );
  expect(undo.friction).toEqual({ kind: "confirm" });
  expect(undo.affected[0]?.title).toBe("Its pods go");
  expect(undo.affected[0]?.objects).toHaveLength(2);
});

test("a drain cordons the node and lists the pods it evicts", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "kind-local"));
  const node = pod("kind-local").node;
  const plan = await answered(
    backend.invoke("command_plan", {
      action: "drain",
      space: "kind-local",
      node,
    }),
  );
  expect(plan.friction).toEqual({ kind: "confirm" });
  expect(plan.kubectl).toBe(
    `kubectl --context kind-local drain ${node} --ignore-daemonsets`,
  );
  expect(plan.affected[0]?.objects.map((object) => object.name)).toContain(
    pod("kind-local").name,
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
      space: "kind-local",
      node,
      unschedulable: true,
    }),
  );
  expect(again.message).toBe(`Node ${node} is cordoned already`);
});

test("a stopped drain evicts nothing more and leaves the node cordoned", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "kind-local"));
  const { node, name } = pod("kind-local");
  const plan = await answered(
    backend.invoke("command_plan", {
      action: "drain",
      space: "kind-local",
      node,
    }),
  );
  const events: OperationEvent[] = [];
  await answered(
    backend.subscribe(
      "command_execute",
      { plan: plan.id, typed: null },
      (event) => {
        events.push(event);
      },
    ),
  );
  await answered(backend.invoke("command_cancel", plan.id));
  await vi.advanceTimersByTimeAsync(2000);
  const pods = plan.affected[0]?.objects.length ?? 0;
  expect(events[events.length - 1]).toEqual({
    state: "stopped",
    text: `Stopped draining node ${node}, which stays cordoned; it evicted 0 of ${String(pods)} pod${pods === 1 ? "" : "s"}`,
  });
  const again = await answered(
    backend.invoke("command_plan", {
      action: "drain",
      space: "kind-local",
      node,
    }),
  );
  expect(again.affected[0]?.objects.map((object) => object.name)).toContain(
    name,
  );
  const uncordon = await answered(
    backend.invoke("command_plan", {
      action: "cordon",
      space: "kind-local",
      node,
      unschedulable: false,
    }),
  );
  expect(uncordon.question).toBe(`Uncordon node ${node} on kind-local?`);
});

test("suspending a job that runs asks, and so does undoing its resume", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "kind-local"));
  const trigger = await answered(
    backend.invoke("command_plan", {
      action: "trigger",
      space: "kind-local",
      namespace: "batch",
      name: "cleanup",
    }),
  );
  await answered(
    backend.subscribe(
      "command_execute",
      { plan: trigger.id, typed: null },
      () => undefined,
    ),
  );
  await vi.advanceTimersByTimeAsync(10);
  const job = /^Job (\S+) runs once/.exec(trigger.consequences[0] ?? "")?.[1];
  const suspend = (on: boolean): PlanRequest => ({
    action: "suspend",
    space: "kind-local",
    target: {
      gvr: { group: "batch", version: "v1", resource: "jobs" },
      namespaced: true,
      namespace: "batch",
      name: job ?? "",
    },
    suspend: on,
  });
  const stopping = await answered(
    backend.invoke("command_plan", suspend(true)),
  );
  expect(stopping.friction).toEqual({ kind: "confirm" });
  expect(stopping.consequences).toEqual([
    "Its running pods stop and their work is lost; when it resumes, new ones start.",
  ]);
  await answered(
    backend.subscribe(
      "command_execute",
      { plan: stopping.id, typed: null },
      () => undefined,
    ),
  );
  await vi.advanceTimersByTimeAsync(5000);
  const resume = await answered(backend.invoke("command_plan", suspend(false)));
  expect(resume.friction).toEqual({ kind: "atOnce" });
  await answered(
    backend.subscribe(
      "command_execute",
      { plan: resume.id, typed: null },
      () => undefined,
    ),
  );
  await vi.advanceTimersByTimeAsync(10);
  const back = await answered(
    backend.invoke("command_plan", { action: "undo", space: "kind-local" }),
  );
  expect(back.friction).toEqual({ kind: "confirm" });
});

test("a trigger asks in a dialog and names the job it makes", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "kind-local"));
  const plan = await answered(
    backend.invoke("command_plan", {
      action: "trigger",
      space: "kind-local",
      namespace: "batch",
      name: "report",
    }),
  );
  expect(plan.friction).toEqual({ kind: "confirm" });
  const job = /^Job (\S+) runs once/.exec(plan.consequences[0] ?? "")?.[1];
  expect(job).toMatch(/^report-manual-[bcdfghjklmnpqrstvwxz2456789]{5}$/);
  expect(plan.kubectl).toBe(
    `kubectl --context kind-local create job ${job ?? ""} --from cronjob/report -n batch`,
  );
  expect(await run(backend, plan.id)).toEqual([
    { state: "done", text: `Created job ${job ?? ""}`, undoUntil: null },
  ]);
});

test("a delete of several asks for the context's name typed and lists them", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "kind-local"));
  const pods = new Cluster(
    "kind-local",
    POD_COUNT["kind-local"] ?? 0,
    0,
  ).pods.slice(0, 3);
  const plan = await answered(
    backend.invoke("command_plan", {
      action: "delete",
      space: "kind-local",
      targets: pods.map((each) => ({
        gvr: { group: "", version: "v1", resource: "pods" },
        namespaced: true,
        namespace: each.namespace,
        name: each.name,
      })),
    }),
  );
  expect(plan.friction).toEqual({ kind: "typed", text: "kind-local" });
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
    name: null,
  }));
  const viewer = createMockBackend("viewer");
  expect(
    await answered(
      viewer.invoke("access_review", {
        space: "kind-local",
        namespace: null,
        checks,
      }),
    ),
  ).toEqual([true, false, false]);
  const admin = createMockBackend("live");
  expect(
    await answered(
      admin.invoke("access_review", {
        space: "kind-local",
        namespace: null,
        checks,
      }),
    ),
  ).toEqual([true, true, true]);
});

test("only a Job's latest start completes it, and one that completed is neither suspended nor resumed", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "kind-local"));
  const execute = async (plan: number) => {
    await answered(
      backend.subscribe(
        "command_execute",
        { plan, typed: null },
        () => undefined,
      ),
    );
    await vi.advanceTimersByTimeAsync(10);
  };
  const trigger = await answered(
    backend.invoke("command_plan", {
      action: "trigger",
      space: "kind-local",
      namespace: "batch",
      name: "cleanup",
    }),
  );
  await execute(trigger.id);
  const job = /^Job (\S+) runs once/.exec(trigger.consequences[0] ?? "")?.[1];
  const suspend = (on: boolean): PlanRequest => ({
    action: "suspend",
    space: "kind-local",
    target: {
      gvr: { group: "batch", version: "v1", resource: "jobs" },
      namespaced: true,
      namespace: "batch",
      name: job ?? "",
    },
    suspend: on,
  });
  await execute(
    (await answered(backend.invoke("command_plan", suspend(true)))).id,
  );
  await vi.advanceTimersByTimeAsync(1000);
  await execute(
    (await answered(backend.invoke("command_plan", suspend(false)))).id,
  );
  await vi.advanceTimersByTimeAsync(3000);
  const running = await answered(backend.invoke("command_plan", suspend(true)));
  expect(running.friction).toEqual({ kind: "confirm" });
  await answered(backend.invoke("command_cancel", running.id));
  await vi.advanceTimersByTimeAsync(1100);
  const error = await refused(backend.invoke("command_plan", suspend(true)));
  expect(error.kind).toBe("invalidInput");
  expect(error.message).toBe(
    `Job ${job ?? ""} has completed, so there is nothing to suspend`,
  );
});

test("a scale whose replicas moved since its plan scales nothing, and one that finds them there offers no undo", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "kind-local"));
  const { target, name, count } = deployment();
  const scale = (replicas: number): PlanRequest => ({
    action: "scale",
    space: "kind-local",
    target,
    replicas,
  });
  const late = await answered(backend.invoke("command_plan", scale(count + 3)));
  const there = await answered(
    backend.invoke("command_plan", scale(count + 1)),
  );
  const again = await answered(
    backend.invoke("command_plan", scale(count + 1)),
  );
  await run(backend, there.id);
  expect(await run(backend, late.id)).toEqual([
    {
      state: "failed",
      error: {
        kind: "conflict",
        message: `Deployment ${name} has ${String(count + 1)} replicas now, not the ${String(count)} Twigo asked about, so it scaled nothing`,
      },
    },
  ]);
  expect(await run(backend, again.id)).toEqual([
    {
      state: "done",
      text: `Deployment ${name} has ${String(count + 1)} replicas already`,
      undoUntil: null,
    },
  ]);
});

test("a cordon that finds the node cordoned already offers no undo", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "kind-local"));
  const cordon: PlanRequest = {
    action: "cordon",
    space: "kind-local",
    node: "kind-local-node-1",
    unschedulable: true,
  };
  const first = await answered(backend.invoke("command_plan", cordon));
  const second = await answered(backend.invoke("command_plan", cordon));
  await run(backend, first.id);
  expect(await run(backend, second.id)).toEqual([
    {
      state: "done",
      text: "Node kind-local-node-1 is cordoned already",
      undoUntil: null,
    },
  ]);
});

test("a Job that completes before its suspend runs is not suspended, nor its resume undone", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "kind-local"));
  const execute = async (plan: number) => {
    const events: OperationEvent[] = [];
    await answered(
      backend.subscribe("command_execute", { plan, typed: null }, (event) => {
        events.push(event);
      }),
    );
    await vi.advanceTimersByTimeAsync(10);
    return events;
  };
  const trigger = await answered(
    backend.invoke("command_plan", {
      action: "trigger",
      space: "kind-local",
      namespace: "batch",
      name: "cleanup",
    }),
  );
  await execute(trigger.id);
  const job =
    /^Job (\S+) runs once/.exec(trigger.consequences[0] ?? "")?.[1] ?? "";
  const suspend = (on: boolean): PlanRequest => ({
    action: "suspend",
    space: "kind-local",
    target: {
      gvr: { group: "batch", version: "v1", resource: "jobs" },
      namespaced: true,
      namespace: "batch",
      name: job,
    },
    suspend: on,
  });
  const late = await answered(backend.invoke("command_plan", suspend(true)));
  await vi.advanceTimersByTimeAsync(5000);
  expect(await execute(late.id)).toEqual([
    {
      state: "failed",
      error: {
        kind: "invalidInput",
        message: `Job ${job} has completed, so there is nothing to suspend`,
      },
    },
  ]);

  const again = await answered(
    backend.invoke("command_plan", {
      action: "trigger",
      space: "kind-local",
      namespace: "batch",
      name: "cleanup",
    }),
  );
  await execute(again.id);
  const next =
    /^Job (\S+) runs once/.exec(again.consequences[0] ?? "")?.[1] ?? "";
  const of = (on: boolean): PlanRequest => ({
    action: "suspend",
    space: "kind-local",
    target: {
      gvr: { group: "batch", version: "v1", resource: "jobs" },
      namespaced: true,
      namespace: "batch",
      name: next,
    },
    suspend: on,
  });
  await execute((await answered(backend.invoke("command_plan", of(true)))).id);
  await execute((await answered(backend.invoke("command_plan", of(false)))).id);
  await vi.advanceTimersByTimeAsync(5000);
  const error = await refused(
    backend.invoke("command_plan", { action: "undo", space: "kind-local" }),
  );
  expect(error.kind).toBe("conflict");
  expect(error.message).toBe(
    `Job ${next} has completed since you resumed it, so Twigo left it`,
  );
});

test("a delete of marked rows leaves out one gone since, and a cron job's resume says what it starts and asks", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "kind-local"));
  const { namespace, name } = pod("kind-local");
  const ref = (named: string) => ({
    gvr: { group: "", version: "v1", resource: "pods" },
    namespaced: true,
    namespace,
    name: named,
  });
  const plan = await answered(
    backend.invoke("command_plan", {
      action: "delete",
      space: "kind-local",
      targets: [ref(name), ref("ghost")],
    }),
  );
  expect(plan.question).toBe(
    `Delete pod ${name} in ${namespace} from kind-local?`,
  );
  expect(plan.friction).toEqual({ kind: "countdown", seconds: 5 });
  expect(plan.consequences).toContain(
    "Gone already, so not in this delete: ghost.",
  );
  await answered(backend.invoke("command_cancel", plan.id));
  const error = await refused(
    backend.invoke("command_plan", {
      action: "delete",
      space: "kind-local",
      targets: [ref("ghost")],
    }),
  );
  expect(error.kind).toBe("notFound");

  const cron = (suspend: boolean): PlanRequest => ({
    action: "suspend",
    space: "kind-local",
    target: {
      gvr: { group: "batch", version: "v1", resource: "cronjobs" },
      namespaced: true,
      namespace: "batch",
      name: "cleanup",
    },
    suspend,
  });
  const suspended = await answered(backend.invoke("command_plan", cron(true)));
  await run(backend, suspended.id);
  const back = await answered(
    backend.invoke("command_plan", { action: "undo", space: "kind-local" }),
  );
  expect(back.consequences).toEqual([
    "Its schedule starts jobs again, and the latest run it missed while suspended starts at once, unless its starting deadline has passed.",
  ]);
  expect(back.friction).toEqual({ kind: "confirm" });
  expect(back.destructive).toBe(false);
  const resume = await answered(backend.invoke("command_plan", cron(false)));
  expect(resume.consequences).toEqual(back.consequences);
  expect(resume.friction).toEqual({ kind: "confirm" });
  expect(resume.destructive).toBe(false);
});

test("a run whose object went since its plan fails, as Rust's read of it does", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "kind-local"));
  const node = "kind-local-node-2";
  const cordon = await answered(
    backend.invoke("command_plan", {
      action: "cordon",
      space: "kind-local",
      node,
      unschedulable: true,
    }),
  );
  const remove = await answered(
    backend.invoke("command_plan", {
      action: "delete",
      space: "kind-local",
      targets: [
        {
          gvr: { group: "", version: "v1", resource: "nodes" },
          namespaced: false,
          namespace: null,
          name: node,
        },
      ],
    }),
  );
  await run(backend, remove.id, node);
  expect(await run(backend, cordon.id)).toEqual([
    {
      state: "failed",
      error: { kind: "notFound", message: `nodes "${node}" not found` },
    },
  ]);
});

test("a delete whose object went before it ran says so and takes nothing else", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "kind-local"));
  const trigger = await answered(
    backend.invoke("command_plan", {
      action: "trigger",
      space: "kind-local",
      namespace: "batch",
      name: "cleanup",
    }),
  );
  await run(backend, trigger.id);
  const job =
    /^Job (\S+) runs once/.exec(trigger.consequences[0] ?? "")?.[1] ?? "";
  const later = await answered(
    backend.invoke("command_plan", {
      action: "trigger",
      space: "kind-local",
      namespace: "batch",
      name: "cleanup",
    }),
  );
  await run(backend, later.id);
  const last =
    /^Job (\S+) runs once/.exec(later.consequences[0] ?? "")?.[1] ?? "";
  const remove: PlanRequest = {
    action: "delete",
    space: "kind-local",
    targets: [
      {
        gvr: { group: "batch", version: "v1", resource: "jobs" },
        namespaced: true,
        namespace: "batch",
        name: job,
      },
    ],
  };
  const first = await answered(backend.invoke("command_plan", remove));
  const second = await answered(backend.invoke("command_plan", remove));
  const lastStays: PlanRequest = {
    action: "delete",
    space: "kind-local",
    targets: [
      {
        gvr: { group: "batch", version: "v1", resource: "jobs" },
        namespaced: true,
        namespace: "batch",
        name: last,
      },
    ],
  };
  await run(backend, first.id);
  expect(await run(backend, second.id)).toEqual([
    { state: "done", text: `Job ${job} was already gone`, undoUntil: null },
  ]);
  const still = await answered(backend.invoke("command_plan", lastStays));
  expect(still.question).toContain(`job ${last}`);
});

test("pods that come and go leave each deployment its replicas", () => {
  const cluster = new Cluster("staging", POD_COUNT.staging ?? 0, 0);
  const count = () => {
    const per = new Map<string, number>();
    for (const pod of cluster.pods) {
      const key = `${pod.namespace}/${deploymentOf(pod)}`;
      per.set(key, (per.get(key) ?? 0) + 1);
    }
    return per;
  };
  const before = count();
  for (let tick = 0; tick < 20; tick++) cluster.churn(3, [], Date.now());
  expect(count()).toEqual(before);
});

const EDITED = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "settings", namespace: "default" },
  data: { a: "1" },
};

function applyEdit(annotation: string | null) {
  const metadata =
    annotation === null
      ? EDITED.metadata
      : {
          ...EDITED.metadata,
          annotations: { "mock.twigo.io/answer": annotation },
        };
  return {
    space: "kind-local",
    opened: {
      target: {
        gvr: { group: "", version: "v1", resource: "configmaps" },
        namespaced: true,
        namespace: "default",
        name: "settings",
      },
      base: { ...EDITED, data: { a: "0" } },
      lock: "1",
    },
    edited: { ...EDITED, metadata },
    force: false,
    drop: [],
  };
}

test("apply_preview answers each case of the enum, and a ready one's plan runs once", async () => {
  const backend = createMockBackend();
  await answered(backend.invoke("space_open", "kind-local"));
  const unchanged = await answered(
    backend.invoke("apply_preview", {
      ...applyEdit(null),
      edited: applyEdit(null).opened.base,
    }),
  );
  expect(unchanged).toEqual({ state: "unchanged", ignored: [] });
  for (const [annotation, state] of [
    ["conflicts", "conflicts"],
    ["stale", "stale"],
    ["immutable", "immutable"],
    ["recreate", "immutable"],
    ["removals", "ready"],
    ["merge-patch", "ready"],
    [null, "ready"],
  ] as const) {
    const answer = await answered(
      backend.invoke("apply_preview", applyEdit(annotation)),
    );
    expect(answer.state).toBe(state);
  }
  const ready = await answered(
    backend.invoke("apply_preview", applyEdit(null)),
  );
  if (ready.state !== "ready") throw new Error("expected ready");
  expect(ready.live).toEqual({ ...EDITED, data: { a: "0" } });
  const plan = await answered(
    backend.invoke("command_plan", {
      action: "apply",
      space: "kind-local",
      preview: ready.id,
    }),
  );
  expect(plan.friction).toEqual({ kind: "atOnce" });
  expect(plan.confirm).toBe("Apply");
  const events = await run(backend, plan.id);
  expect(events).toEqual([
    { state: "done", text: "Applied configmap settings", undoUntil: null },
  ]);
  const again = await refused(
    backend.invoke("command_plan", {
      action: "apply",
      space: "kind-local",
      preview: ready.id,
    }),
  );
  expect(again.kind).toBe("notFound");
});

test("a recreate's plan asks and names what it deletes", async () => {
  const backend = createMockBackend();
  await answered(backend.invoke("space_open", "kind-local"));
  const answer = await answered(
    backend.invoke("apply_preview", applyEdit("recreate")),
  );
  if (answer.state !== "immutable" || answer.recreate === null) {
    throw new Error("expected a recreate");
  }
  const plan = await answered(
    backend.invoke("command_plan", {
      action: "apply",
      space: "kind-local",
      preview: answer.recreate,
    }),
  );
  expect(plan.destructive).toBe(true);
  expect(plan.friction).toEqual({ kind: "confirm" });
});

test("an apply is at once in read-write, asks in guarded and is blocked in read-only", async () => {
  const backend = createMockBackend();
  await answered(backend.invoke("space_open", "kind-local"));
  for (const [mode, expected] of [
    ["guarded", { kind: "confirm" }],
    ["read-write", { kind: "atOnce" }],
  ] as const) {
    await change(backend, { action: "setMode", context: "kind-local", mode });
    const answer = await answered(
      backend.invoke("apply_preview", applyEdit(null)),
    );
    if (answer.state !== "ready") throw new Error("expected ready");
    const plan = await answered(
      backend.invoke("command_plan", {
        action: "apply",
        space: "kind-local",
        preview: answer.id,
      }),
    );
    expect(plan.friction).toEqual(expected);
  }
  await change(backend, {
    action: "setMode",
    context: "kind-local",
    mode: "read-only",
  });
  const answer = await answered(
    backend.invoke("apply_preview", applyEdit(null)),
  );
  if (answer.state !== "ready") throw new Error("expected ready");
  const blocked = await refused(
    backend.invoke("command_plan", {
      action: "apply",
      space: "kind-local",
      preview: answer.id,
    }),
  );
  expect(blocked.kind).toBe("permissions");
});

test("a recreate is blocked by its first write, a delete, in read-only", async () => {
  const backend = createMockBackend();
  await answered(backend.invoke("space_open", "kind-local"));
  const answer = await answered(
    backend.invoke("apply_preview", applyEdit("recreate")),
  );
  if (answer.state !== "immutable" || answer.recreate === null) {
    throw new Error("expected a recreate");
  }
  await change(backend, {
    action: "setMode",
    context: "kind-local",
    mode: "read-only",
  });
  const blocked = await refused(
    backend.invoke("command_plan", {
      action: "apply",
      space: "kind-local",
      preview: answer.recreate,
    }),
  );
  expect(blocked.kind).toBe("permissions");
  expect(blocked.message).toContain("delete");
});

test("a newer preview of an object drops the plan of an older one that waits", async () => {
  const backend = createMockBackend();
  await answered(backend.invoke("space_open", "kind-local"));
  const older = await answered(
    backend.invoke("apply_preview", applyEdit(null)),
  );
  if (older.state !== "ready") throw new Error("expected ready");
  const waiting = await planOf(backend, older.id);
  await answered(backend.invoke("apply_preview", applyEdit("stale")));
  const gone = await refused(
    backend.subscribe(
      "command_execute",
      { plan: waiting.id, typed: null },
      () => undefined,
    ),
  );
  expect(gone.kind).toBe("notFound");
});

test("a newer preview of an object replaces an older one, whatever it answers", async () => {
  const backend = createMockBackend();
  await answered(backend.invoke("space_open", "kind-local"));
  const older = await answered(
    backend.invoke("apply_preview", applyEdit(null)),
  );
  if (older.state !== "ready") throw new Error("expected ready");
  await answered(backend.invoke("apply_preview", applyEdit("stale")));
  const gone = await refused(
    backend.invoke("command_plan", {
      action: "apply",
      space: "kind-local",
      preview: older.id,
    }),
  );
  expect(gone.kind).toBe("notFound");
});

function planOf(
  backend: ReturnType<typeof createMockBackend>,
  preview: number,
) {
  return answered(
    backend.invoke("command_plan", {
      action: "apply",
      space: "kind-local",
      preview,
    }),
  );
}

test("a plan's kubectl line and consequences say how its edit is sent", async () => {
  const backend = createMockBackend();
  await answered(backend.invoke("space_open", "kind-local"));

  const byPatch = await answered(
    backend.invoke("apply_preview", applyEdit("merge-patch")),
  );
  if (byPatch.state !== "ready") throw new Error("expected ready");
  const patchPlan = await planOf(backend, byPatch.id);
  expect(patchPlan.kubectl).toContain(
    "kubectl patch configmaps settings -n default --type=merge --field-manager=twigo-edit",
  );
  expect(patchPlan.kubectl).not.toContain("--server-side");
  expect(patchPlan.consequences).toEqual([
    "An apply cannot express this edit, so it goes as one merge patch under field manager twigo-edit, as kubectl edit would.",
  ]);

  const withRemoval = await answered(
    backend.invoke("apply_preview", applyEdit("removals")),
  );
  if (withRemoval.state !== "ready") throw new Error("expected ready");
  const removalPlan = await planOf(backend, withRemoval.id);
  expect(removalPlan.kubectl).toContain("--server-side");
  expect(removalPlan.kubectl).toContain("--type=merge");
  expect(removalPlan.consequences).toEqual([
    "Then a merge patch removes .metadata.labels.team.",
  ]);

  const replaced = await answered(
    backend.invoke("apply_preview", applyEdit("recreate")),
  );
  if (replaced.state !== "immutable" || replaced.recreate === null) {
    throw new Error("expected a recreate");
  }
  const recreatePlan = await planOf(backend, replaced.recreate);
  expect(recreatePlan.kubectl).toContain(
    "kubectl delete configmaps settings -n default && kubectl create",
  );
  expect(recreatePlan.kubectl).not.toContain("--server-side");
  expect(recreatePlan.consequences).toEqual([
    "It goes, and a new one with a new uid takes its place.",
  ]);
});

test("a Job's recreate says it runs again, in its own words", async () => {
  const backend = createMockBackend();
  await answered(backend.invoke("space_open", "kind-local"));
  const edit = applyEdit("recreate");
  const answer = await answered(
    backend.invoke("apply_preview", {
      ...edit,
      opened: {
        ...edit.opened,
        target: {
          ...edit.opened.target,
          gvr: { group: "batch", version: "v1", resource: "jobs" },
        },
      },
    }),
  );
  if (answer.state !== "immutable" || answer.recreate === null) {
    throw new Error("expected a recreate");
  }
  const plan = await planOf(backend, answer.recreate);
  expect(plan.consequences).toEqual([
    "It goes with its pods, and a new one with a new uid runs from the start, whatever this one finished.",
  ]);
  expect(plan.kubectl).toContain("kubectl delete jobs.batch settings");
});

test("the two sides of a preview lose resourceVersion and generation, as Rust's do", async () => {
  const backend = createMockBackend();
  await answered(backend.invoke("space_open", "kind-local"));
  const edit = applyEdit(null);
  const server = { resourceVersion: "9", generation: 2 };
  const answer = await answered(
    backend.invoke("apply_preview", {
      ...edit,
      opened: {
        ...edit.opened,
        base: {
          ...edit.opened.base,
          metadata: { ...edit.opened.base.metadata, ...server },
        },
      },
      edited: {
        ...edit.edited,
        metadata: { ...edit.edited.metadata, ...server },
      },
    }),
  );
  if (answer.state !== "ready") throw new Error("expected ready");
  expect(answer.live).toEqual({ ...EDITED, data: { a: "0" } });
  expect(answer.result).toEqual(EDITED);
});

const SET_MODE = (context: string, mode: Mode | null): Protection => ({
  action: "setMode",
  context,
  mode,
});

const SET_ENVIRONMENT = (
  context: string,
  environment: Environment | null,
): Protection => ({ action: "setEnvironment", context, environment });

test("a lasting change that lowers protection asks for the name typed, and one that tightens or keeps it runs at once", async () => {
  const backend = createMockBackend();
  const friction = async (request: PlanRequest) =>
    (await answered(backend.invoke("command_plan", request))).friction;

  expect(await friction(SET_MODE("prod-eu", "read-write"))).toEqual({
    kind: "typed",
    text: "prod-eu",
  });
  expect(await friction(SET_MODE("prod-eu", "guarded"))).toEqual({
    kind: "typed",
    text: "prod-eu",
  });
  expect(await friction(SET_MODE("staging", "read-only"))).toEqual({
    kind: "atOnce",
  });
  expect(await friction(SET_MODE("staging", "guarded"))).toEqual({
    kind: "atOnce",
  });
  expect(await friction(SET_ENVIRONMENT("staging", "development"))).toEqual({
    kind: "typed",
    text: "staging",
  });
  expect(await friction(SET_ENVIRONMENT("dev", "production"))).toEqual({
    kind: "atOnce",
  });
  expect(await friction(SET_ENVIRONMENT("prod-eu", null))).toEqual({
    kind: "typed",
    text: "prod-eu",
  });
});

test("a type weighs the mode a context would have with no lock but the type, so a lock another source holds cannot hide a lowering", async () => {
  const friction = async (
    backend: ReturnType<typeof createMockBackend>,
    request: PlanRequest,
  ) => (await answered(backend.invoke("command_plan", request))).friction;
  const environments = [
    "production",
    "staging",
    "development",
    "local",
    null,
  ] as const;
  const atOnce = { kind: "atOnce" };

  const kubeconfig = createMockBackend();
  for (const environment of environments) {
    expect(
      await friction(kubeconfig, SET_ENVIRONMENT("analytics", environment)),
    ).toEqual(atOnce);
  }
  await change(kubeconfig, SET_MODE("analytics", null));
  expect(
    await Promise.all(
      environments.map((environment) =>
        friction(kubeconfig, SET_ENVIRONMENT("analytics", environment)),
      ),
    ),
  ).toEqual([
    atOnce,
    atOnce,
    { kind: "typed", text: "analytics" },
    { kind: "typed", text: "analytics" },
    atOnce,
  ]);

  const filed = createMockBackend("policyFile");
  await change(filed, SET_ENVIRONMENT("prod-eu", null));
  expect(
    await Promise.all(
      environments.map((environment) =>
        friction(filed, SET_ENVIRONMENT("prod-eu", environment)),
      ),
    ),
  ).toEqual([
    atOnce,
    atOnce,
    { kind: "typed", text: "prod-eu" },
    { kind: "typed", text: "prod-eu" },
    atOnce,
  ]);
});

test("a type, or a mode cleared, beneath a kubeconfig's lock asks as what it gives once the lock goes, and says so", async () => {
  const backend = createMockBackend();
  const plan = (request: PlanRequest) =>
    answered(backend.invoke("command_plan", request));
  await change(backend, SET_MODE("analytics", "read-only"));

  const marked = await plan(SET_ENVIRONMENT("analytics", "development"));
  expect(marked.friction).toEqual({ kind: "atOnce" });
  expect(marked.consequences).toEqual(["It stays read-only by your choice."]);
  await change(backend, SET_ENVIRONMENT("analytics", "development"));

  const cleared = await plan(SET_MODE("analytics", null));
  expect(cleared.friction).toEqual({ kind: "typed", text: "analytics" });
  expect(cleared.consequences).toEqual([
    "It stays read-only as its kubeconfig says.",
    "When its kubeconfig's lock goes, it will be read-write.",
  ]);

  await change(backend, SET_ENVIRONMENT("analytics", "staging"));
  const guarded = await plan(SET_MODE("analytics", null));
  expect(guarded.friction).toEqual({ kind: "typed", text: "analytics" });
  expect(guarded.consequences).toEqual([
    "It stays read-only as its kubeconfig says.",
    "When its kubeconfig's lock goes, it will be guarded.",
  ]);

  await change(backend, SET_ENVIRONMENT("analytics", "production"));
  const kept = await plan(SET_MODE("analytics", null));
  expect(kept.friction).toEqual({ kind: "atOnce" });
  expect(kept.consequences).toEqual([
    "It stays read-only as its kubeconfig says.",
  ]);
});

test("clearing a type weighs as a change to read-write, and leaves the context unmarked whatever its kubeconfig says", async () => {
  const backend = createMockBackend();
  const friction = async (request: PlanRequest) =>
    (await answered(backend.invoke("command_plan", request))).friction;
  expect(await friction(SET_ENVIRONMENT("staging", null))).toEqual({
    kind: "typed",
    text: "staging",
  });
  expect(await friction(SET_ENVIRONMENT("dev", null))).toEqual({
    kind: "atOnce",
  });
  await change(backend, SET_ENVIRONMENT("staging", null));
  const watched = await answered(
    backend.subscribe("contexts_watch", null, () => undefined),
  );
  expect(watched.find((context) => context.name === "staging")?.access).toEqual(
    UNMARKED,
  );
  expect(await friction(SET_ENVIRONMENT("staging", "production"))).toEqual({
    kind: "atOnce",
  });
});

test("an unlock counts as read-only when a type clears or lowers the mode", async () => {
  const backend = createMockBackend();
  await change(backend, { action: "unlock", context: "prod-eu" });
  const plan = await answered(
    backend.invoke("command_plan", SET_ENVIRONMENT("prod-eu", "staging")),
  );
  expect(plan.friction).toEqual({ kind: "typed", text: "prod-eu" });
  expect(plan.consequences).toContain("Its unlock ends.");
});

test("a protection plan says what changes in Rust's words, out of an unmarked context and under a lock it sets aside included", async () => {
  const OPENED = "Writes and shells are no longer refused";
  const AT_ONCE = `${OPENED}: a scale, an apply or a shell runs at once, and a delete asks in a dialog.`;
  const WITHOUT_ASKING =
    "Processes in its terminals write and exec without asking, and new terminals use your own kubeconfig.";
  const said = async (request: Protection, filed = false) => {
    const { question, confirm, consequences } = await answered(
      createMockBackend(filed ? "policyFile" : undefined).invoke(
        "command_plan",
        request,
      ),
    );
    return { question, confirm, consequences };
  };

  expect(await said(SET_ENVIRONMENT("qa", "staging"))).toEqual({
    question: "Mark qa as Staging?",
    confirm: "Mark as Staging",
    consequences: [
      `${OPENED}: each write asks for qa's name typed, and a shell or an apply asks in a dialog.`,
      "A process's write or exec in its terminals asks you to allow it, rather than what qa is.",
    ],
  });
  expect(
    (await said(SET_ENVIRONMENT("qa", "production"))).consequences,
  ).toEqual([
    "Every write, exec and shell stays refused; reads, dry runs and port-forwards go on.",
    "A process's write or exec in its terminals is refused, rather than asking what qa is.",
  ]);
  expect((await said(SET_ENVIRONMENT("qa", "local"))).consequences).toEqual([
    AT_ONCE,
    WITHOUT_ASKING,
  ]);
  expect(await said(SET_ENVIRONMENT("dev", null))).toEqual({
    question: "Clear the type of dev, whatever its kubeconfig says?",
    confirm: "Clear type",
    consequences: [
      "Its first write or exec asks what dev is, and nothing is sent until you say.",
    ],
  });
  expect(await said(SET_MODE("analytics", null))).toEqual({
    question:
      "Make analytics read-only as its kubeconfig says, in place of your mode?",
    confirm: "Make read-only",
    consequences: [
      "Every write, exec and shell is refused; reads, dry runs and port-forwards go on.",
      "When its kubeconfig's lock goes, its first write or exec asks what analytics is.",
    ],
  });
  expect(await said(SET_MODE("staging", "read-write"))).toMatchObject({
    question: "Make staging read-write?",
    consequences: [
      "Writes stop asking for staging's name: a scale, an apply or a shell runs at once, and a delete asks in a dialog.",
      WITHOUT_ASKING,
      "It sets aside the guarded Staging sets by default.",
    ],
  });
  const FILE = "/Library/Application Support/Twigo/policy.json";
  const STAYS = `It stays read-only by prod-* in ${FILE}.`;
  const filed = async (environment: Environment | null) =>
    (await said(SET_ENVIRONMENT("prod-eu", environment), true)).consequences;
  expect(await filed("production")).toEqual([STAYS]);
  expect(await filed("staging")).toEqual([
    STAYS,
    `When ${FILE} no longer sets its mode, it will be guarded.`,
  ]);
  expect(await filed("development")).toEqual([
    STAYS,
    `When ${FILE} no longer sets its mode, it will be read-write.`,
  ]);
  expect(await filed(null)).toEqual([
    STAYS,
    `When ${FILE} no longer sets its mode, its first write or exec asks what prod-eu is.`,
  ]);
  expect(await said({ action: "unlock", context: "prod-eu" })).toEqual({
    question: "Unlock prod-eu for 15 minutes?",
    confirm: "Unlock for 15 minutes",
    consequences: [
      `${OPENED}: each write asks for prod-eu's name typed, and a shell or an apply asks in a dialog.`,
      "A process's write or exec in its terminals waits for your answer.",
      "It relocks by itself in 15 minutes.",
    ],
  });
});

test("an unlock asks in a dialog, and its plan has no kubectl command", async () => {
  const backend = createMockBackend();
  const plan = await answered(
    backend.invoke("command_plan", { action: "unlock", context: "prod-eu" }),
  );
  expect(plan.friction).toEqual({ kind: "confirm" });
  expect(plan.kubectl).toBeNull();
  const nothing = await refused(
    backend.invoke("command_plan", { action: "unlock", context: "staging" }),
  );
  expect(nothing.kind).toBe("invalidInput");
});

test("any change of a context nobody marked runs at once, and marking it sets the mode its type gives", async () => {
  const backend = createMockBackend();
  const mode = await answered(
    backend.invoke("command_plan", SET_MODE("qa", "read-write")),
  );
  const type = await answered(
    backend.invoke("command_plan", SET_ENVIRONMENT("qa", "production")),
  );
  expect([mode.friction, type.friction]).toEqual([
    { kind: "atOnce" },
    { kind: "atOnce" },
  ]);
  await change(backend, SET_ENVIRONMENT("qa", "production"));
  const watched = await answered(
    backend.subscribe("contexts_watch", null, () => undefined),
  );
  expect(
    watched.find((context) => context.name === "qa")?.access,
  ).toMatchObject({
    mode: "read-only",
    source: { kind: "environment", environment: "production" },
  });
});

test("a protection plan is refused once what the context lets through changed since it was planned", async () => {
  const backend = createMockBackend();
  const execute = (plan: number, typed: string | null) =>
    refused(
      backend.subscribe("command_execute", { plan, typed }, () => undefined),
    );
  const lower = await answered(
    backend.invoke("command_plan", SET_MODE("staging", "read-write")),
  );
  expect(lower.friction).toEqual({ kind: "typed", text: "staging" });
  await change(backend, SET_MODE("staging", "read-only"));
  const stale = await execute(lower.id, "staging");
  expect(stale.kind).toBe("conflict");
  expect(stale.message).toBe(
    "what staging lets through changed since Twigo asked, so Twigo changed nothing",
  );
  const watched = await answered(
    backend.subscribe("contexts_watch", null, () => undefined),
  );
  expect(
    watched.find((context) => context.name === "staging")?.access,
  ).toMatchObject({ mode: "read-only" });

  const tighten = await answered(
    backend.invoke("command_plan", SET_MODE("dev", "guarded")),
  );
  expect(tighten.friction).toEqual({ kind: "atOnce" });
  await change(backend, SET_MODE("dev", "read-only"));
  expect((await execute(tighten.id, null)).kind).toBe("conflict");
});

test("a change that asks for the name typed refuses the wrong one and changes nothing", async () => {
  const backend = createMockBackend();
  const plan = await answered(
    backend.invoke("command_plan", SET_MODE("staging", "read-write")),
  );
  const wrong = await refused(
    backend.subscribe(
      "command_execute",
      { plan: plan.id, typed: "stagin" },
      () => undefined,
    ),
  );
  expect(wrong.message).toBe("type staging to confirm");
  const next = await answered(
    backend.invoke("command_plan", SET_MODE("staging", "read-write")),
  );
  expect(next.friction).toEqual({ kind: "typed", text: "staging" });
});

test("a write or an exec on a context nobody marked is refused as unmarked, before anything is asked", async () => {
  const backend = createMockBackend();
  await answered(backend.invoke("space_open", "qa"));
  const write = await refused(backend.invoke("command_plan", deletePod("qa")));
  expect(write.kind).toBe("permissions");
  expect(write.message).toMatch(
    /^nobody has said what qa is yet, so Twigo did not send delete pods\//,
  );
  expect(write.blocked).toMatchObject({
    context: "qa",
    mode: "guarded",
    source: { kind: "unmarked" },
    reason: "unmarked",
    class: "write",
  });
  const { namespace, name } = pod("qa");
  const exec = await refused(
    backend.invoke("command_plan", {
      action: "shell",
      target: { space: "qa", namespace, pod: name, container: "app" },
      kind: "shell",
    }),
  );
  expect(exec.blocked).toMatchObject({ reason: "unmarked", class: "exec" });

  await change(backend, SET_ENVIRONMENT("qa", "staging"));
  const plan = await answered(backend.invoke("command_plan", deletePod("qa")));
  expect(plan.friction).toEqual({ kind: "typed", text: "qa" });
});

test("an admin's policy file refuses a change of the mode it holds", async () => {
  const backend = createMockBackend("policyFile");
  for (const request of [
    SET_MODE("prod-eu", "read-write"),
    { action: "unlock", context: "prod-eu" } satisfies Protection,
  ]) {
    const error = await refused(backend.invoke("command_plan", request));
    expect(error.kind).toBe("permissions");
    expect(error.message).toContain("prod-*");
  }
  const dev = await answered(
    backend.invoke("command_plan", SET_MODE("dev", "guarded")),
  );
  expect(dev.friction).toEqual({ kind: "atOnce" });
});

test("a type under an admin's policy file weighs the mode the context would have without it", async () => {
  const backend = createMockBackend("policyFile");
  const friction = async (request: PlanRequest) =>
    (await answered(backend.invoke("command_plan", request))).friction;
  const typed = { kind: "typed", text: "prod-eu" };
  expect(await friction(SET_ENVIRONMENT("prod-eu", "production"))).toEqual({
    kind: "atOnce",
  });
  expect(await friction(SET_ENVIRONMENT("prod-eu", "staging"))).toEqual(typed);
  expect(await friction(SET_ENVIRONMENT("prod-eu", "development"))).toEqual(
    typed,
  );
  expect(await friction(SET_ENVIRONMENT("prod-eu", null))).toEqual(typed);

  const plan = await answered(
    backend.invoke("command_plan", SET_ENVIRONMENT("prod-eu", "staging")),
  );
  await run(backend, plan.id, "prod-eu");
  const watched = await answered(
    backend.subscribe("contexts_watch", null, () => undefined),
  );
  expect(
    watched.find((context) => context.name === "prod-eu")?.access,
  ).toMatchObject({
    mode: "read-only",
    source: { kind: "policyFile", pattern: "prod-*" },
    environment: "staging",
  });
});
