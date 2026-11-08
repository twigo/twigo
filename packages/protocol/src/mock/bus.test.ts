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
    `kubectl --context qa scale deployments.apps ${name} --current-replicas ${String(count)} --replicas ${String(count + 2)} -n ${namespace}`,
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

test("the last action is the one that started last, whichever ends first", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "qa"));
  const [drained, cordoned] = ["qa-node-3", "qa-node-4"];
  const drain = await answered(
    backend.invoke("command_plan", {
      action: "drain",
      space: "qa",
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
      space: "qa",
      node: cordoned,
      unschedulable: true,
    }),
  );
  await run(backend, cordon.id);
  const undo = await answered(
    backend.invoke("command_plan", { action: "undo", space: "qa" }),
  );
  expect(undo.question).toBe(`Uncordon node ${cordoned} on qa?`);

  const first = await answered(
    backend.invoke("command_plan", {
      action: "cordon",
      space: "qa",
      node: drained,
      unschedulable: false,
    }),
  );
  const later = await answered(
    backend.invoke("command_plan", {
      action: "drain",
      space: "qa",
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
    backend.invoke("command_plan", { action: "undo", space: "qa" }),
  );
  expect(nothing.kind).toBe("notFound");
});

test("an undo that scales back to zero asks and lists the pods that go", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "qa"));
  const { target } = deployment();
  const scale = (replicas: number): PlanRequest => ({
    action: "scale",
    space: "qa",
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
    backend.invoke("command_plan", { action: "undo", space: "qa" }),
  );
  expect(undo.friction).toEqual({ kind: "confirm" });
  expect(undo.affected[0]?.title).toBe("Its pods go");
  expect(undo.affected[0]?.objects).toHaveLength(2);
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

test("a stopped drain evicts nothing more and leaves the node cordoned", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "qa"));
  const { node, name } = pod("qa");
  const plan = await answered(
    backend.invoke("command_plan", { action: "drain", space: "qa", node }),
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
    backend.invoke("command_plan", { action: "drain", space: "qa", node }),
  );
  expect(again.affected[0]?.objects.map((object) => object.name)).toContain(
    name,
  );
  const uncordon = await answered(
    backend.invoke("command_plan", {
      action: "cordon",
      space: "qa",
      node,
      unschedulable: false,
    }),
  );
  expect(uncordon.question).toBe(`Uncordon node ${node} on qa?`);
});

test("suspending a job that runs asks, and so does undoing its resume", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "qa"));
  const trigger = await answered(
    backend.invoke("command_plan", {
      action: "trigger",
      space: "qa",
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
    space: "qa",
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
    backend.invoke("command_plan", { action: "undo", space: "qa" }),
  );
  expect(back.friction).toEqual({ kind: "confirm" });
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
    name: null,
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

test("only a Job's latest start completes it, and one that completed is neither suspended nor resumed", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "qa"));
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
      space: "qa",
      namespace: "batch",
      name: "cleanup",
    }),
  );
  await execute(trigger.id);
  const job = /^Job (\S+) runs once/.exec(trigger.consequences[0] ?? "")?.[1];
  const suspend = (on: boolean): PlanRequest => ({
    action: "suspend",
    space: "qa",
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
  await answered(backend.invoke("space_open", "qa"));
  const { target, name, count } = deployment();
  const scale = (replicas: number): PlanRequest => ({
    action: "scale",
    space: "qa",
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
  await answered(backend.invoke("space_open", "qa"));
  const cordon: PlanRequest = {
    action: "cordon",
    space: "qa",
    node: "qa-node-1",
    unschedulable: true,
  };
  const first = await answered(backend.invoke("command_plan", cordon));
  const second = await answered(backend.invoke("command_plan", cordon));
  await run(backend, first.id);
  expect(await run(backend, second.id)).toEqual([
    {
      state: "done",
      text: "Node qa-node-1 is cordoned already",
      undoUntil: null,
    },
  ]);
});

test("a Job that completes before its suspend runs is not suspended, nor its resume undone", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "qa"));
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
      space: "qa",
      namespace: "batch",
      name: "cleanup",
    }),
  );
  await execute(trigger.id);
  const job =
    /^Job (\S+) runs once/.exec(trigger.consequences[0] ?? "")?.[1] ?? "";
  const suspend = (on: boolean): PlanRequest => ({
    action: "suspend",
    space: "qa",
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
      space: "qa",
      namespace: "batch",
      name: "cleanup",
    }),
  );
  await execute(again.id);
  const next =
    /^Job (\S+) runs once/.exec(again.consequences[0] ?? "")?.[1] ?? "";
  const of = (on: boolean): PlanRequest => ({
    action: "suspend",
    space: "qa",
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
    backend.invoke("command_plan", { action: "undo", space: "qa" }),
  );
  expect(error.kind).toBe("conflict");
  expect(error.message).toBe(
    `Job ${next} has completed since you resumed it, so Twigo left it`,
  );
});

test("a delete of marked rows leaves out one gone since, and a cron job's resume says what it starts and asks", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "qa"));
  const { namespace, name } = pod("qa");
  const ref = (named: string) => ({
    gvr: { group: "", version: "v1", resource: "pods" },
    namespaced: true,
    namespace,
    name: named,
  });
  const plan = await answered(
    backend.invoke("command_plan", {
      action: "delete",
      space: "qa",
      targets: [ref(name), ref("ghost")],
    }),
  );
  expect(plan.question).toBe(`Delete pod ${name} in ${namespace} from qa?`);
  expect(plan.friction).toEqual({ kind: "countdown", seconds: 5 });
  expect(plan.consequences).toContain(
    "Gone already, so not in this delete: ghost.",
  );
  await answered(backend.invoke("command_cancel", plan.id));
  const error = await refused(
    backend.invoke("command_plan", {
      action: "delete",
      space: "qa",
      targets: [ref("ghost")],
    }),
  );
  expect(error.kind).toBe("notFound");

  const cron = (suspend: boolean): PlanRequest => ({
    action: "suspend",
    space: "qa",
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
    backend.invoke("command_plan", { action: "undo", space: "qa" }),
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
  await answered(backend.invoke("space_open", "qa"));
  const node = "qa-node-2";
  const cordon = await answered(
    backend.invoke("command_plan", {
      action: "cordon",
      space: "qa",
      node,
      unschedulable: true,
    }),
  );
  const remove = await answered(
    backend.invoke("command_plan", {
      action: "delete",
      space: "qa",
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
  await answered(backend.invoke("space_open", "qa"));
  const trigger = await answered(
    backend.invoke("command_plan", {
      action: "trigger",
      space: "qa",
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
      space: "qa",
      namespace: "batch",
      name: "cleanup",
    }),
  );
  await run(backend, later.id);
  const last =
    /^Job (\S+) runs once/.exec(later.consequences[0] ?? "")?.[1] ?? "";
  const remove: PlanRequest = {
    action: "delete",
    space: "qa",
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
    space: "qa",
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
