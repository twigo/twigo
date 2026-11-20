import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { IpcError } from "../error";
import type { Backend } from "../backend";
import type { ApprovalAnswer, ApprovalAsk, ApprovalEvent } from "../generated";
import {
  createMockBackend,
  FIRST_ASK_MS,
  NEXT_ASK_MS,
  protect,
  WITHDRAWN_AFTER_MS,
  type MockScenario,
} from "./index";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function followed(scenario: MockScenario) {
  const backend = createMockBackend(scenario);
  const events: ApprovalEvent[] = [];
  const watch = backend.subscribe("approvals_watch", null, (event) => {
    events.push(event);
  });
  await vi.advanceTimersByTimeAsync(0);
  await watch;
  return { backend, events };
}

const asks = (events: ApprovalEvent[]): ApprovalAsk[] =>
  events.flatMap((event) => (event.event === "asked" ? [event.ask] : []));

interface Side {
  kind: string;
  metadata: Record<string, unknown>;
  spec: { template: { spec: { containers: { image: string }[] } } };
  data: Record<string, string>;
}

function nth(events: ApprovalEvent[], index: number): ApprovalAsk {
  const ask = asks(events)[index];
  if (ask === undefined) throw new Error(`no ask ${String(index)} was raised`);
  return ask;
}

const last = (events: ApprovalEvent[]): ApprovalAsk =>
  nth(events, asks(events).length - 1);

async function answer(
  backend: Backend,
  ask: ApprovalAsk,
  answer: ApprovalAnswer = { kind: "once" },
  typed: string | null = null,
) {
  const sent = backend.invoke("approval_answer", {
    id: ask.id,
    answer,
    typed,
  });
  const caught = sent.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(0);
  return caught;
}

test("the sequence raises its asks one after another as each is answered", async () => {
  const { backend, events } = await followed("approval");
  expect(asks(events)).toEqual([]);

  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  const patch = nth(events, 0);
  expect(patch).toMatchObject({
    process: "Terminal 2",
    verb: "patch",
    detail: { kind: "diff" },
  });
  await vi.advanceTimersByTimeAsync(10 * NEXT_ASK_MS);
  expect(asks(events)).toHaveLength(1);

  expect(await answer(backend, patch)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  expect(asks(events)).toHaveLength(2);
  expect(asks(events)[1]?.detail).toMatchObject({ kind: "diff", live: null });

  for (let step = 1; step < 10; step++) {
    await answer(backend, nth(events, step), { kind: "deny" }, "prod-eu");
    await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  }
  expect(
    asks(events).map(({ detail }) =>
      detail.kind === "unknown" ? detail.reason.reason : detail.kind,
    ),
  ).toEqual([
    "diff",
    "diff",
    "delete",
    "session",
    "subresource",
    "aggregated",
    "refused",
    "diff",
    "diff",
    "delete",
  ]);
  expect(asks(events)[7]?.impersonate).toBe(
    "system:serviceaccount:default:deployer, groups system:serviceaccounts",
  );
});

async function raised(): Promise<ApprovalAsk[]> {
  const { backend, events } = await followed("approval");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  for (let step = 0; step < 10; step++) {
    await answer(backend, nth(events, step), { kind: "deny" }, "prod-eu");
    await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  }
  return asks(events);
}

test("an ask's command is the command path alone, as kubectl's Kubectl-Command header holds it", async () => {
  expect((await raised()).map(({ command }) => command)).toEqual([
    "kubectl set image",
    "kubectl create",
    "kubectl delete",
    "kubectl exec",
    "kubectl scale",
    "kubectl apply",
    "kubectl apply",
    "kubectl annotate",
    "kubectl edit",
    "kubectl delete",
  ]);
});

test("a create is named as its dry run stores it, or by its path alone with none, and an exec by its pod alone, as Rust names them", async () => {
  const all = await raised();
  const [, create, , exec] = all;
  expect(create?.verb).toBe("create");
  const body =
    create?.detail.kind === "diff" ? (create.detail.result as Side) : undefined;
  expect(create?.target).toBe(
    `configmaps/${String(body?.metadata.name)} in default`,
  );
  expect(exec?.detail.kind).toBe("session");
  expect(exec?.target).toMatch(/^pods\/[^/]+ in default$/);
  const undiffed = all.filter(
    (ask) => ask.verb === "create" && ask.detail.kind === "unknown",
  );
  expect(undiffed.length).toBeGreaterThan(0);
  for (const ask of undiffed) {
    expect(ask.target).toMatch(/^[a-z]+ in [a-z-]+$/);
  }
});

test("a scale is a merge patch of the replicas to the scale subresource, and a delete asks for the background propagation, as kubectl sends them", async () => {
  const all = await raised();
  expect(all[4]).toMatchObject({
    verb: "patch",
    target: "deployments/web/scale in default",
    detail: {
      kind: "unknown",
      reason: { reason: "subresource" },
      body: '{"spec":{"replicas":5}}',
    },
  });
  expect(all[2]?.detail).toEqual({
    kind: "delete",
    propagation: "Background",
  });
});

test("an ask with no diff carries its body unless it writes a Secret, as Rust sends it", async () => {
  const unknown = (await raised()).flatMap((ask) =>
    ask.detail.kind === "unknown" ? [ask] : [],
  );
  expect(unknown.length).toBeGreaterThan(0);
  for (const ask of unknown) {
    expect(ask.detail).toHaveProperty(
      "body",
      ask.target.startsWith("secrets/") ? null : expect.any(String),
    );
  }
});

test("a diff's sides are recorded objects with a change made in code, as Rust's side sends them", async () => {
  const { backend, events } = await followed("approval");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  for (let step = 0; step < 10; step++) {
    await answer(backend, nth(events, step), { kind: "deny" }, "prod-eu");
    await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  }
  const diffs = asks(events).flatMap(({ detail }) =>
    detail.kind === "diff" ? [detail] : [],
  );
  expect(diffs).toHaveLength(4);
  const [patch, create, annotate, secret] = diffs;
  const sides = (detail: typeof patch) =>
    detail === undefined ? [] : [detail.live, detail.result];
  for (const side of diffs.flatMap((detail) => sides(detail))) {
    if (side === null) continue;
    const { metadata } = side as Side;
    expect(metadata).not.toHaveProperty("resourceVersion");
    expect(metadata).not.toHaveProperty("generation");
    expect(metadata).toHaveProperty("uid");
  }

  const [before, after] = sides(patch) as Side[];
  expect(before?.metadata).toMatchObject({ name: "web", namespace: "default" });
  expect(
    [before, after].map(
      (side) => side?.spec.template.spec.containers[0]?.image,
    ),
  ).toEqual(["registry.k8s.io/pause:3.10", "registry.k8s.io/pause:3.11"]);
  expect({ ...before, spec: undefined }).toEqual({ ...after, spec: undefined });

  expect(create?.live).toBeNull();
  expect((create?.result as Side).kind).toBe("ConfigMap");
  expect((annotate?.result as Side).metadata.annotations).toEqual({
    team: "payments",
  });

  const [masked, changed] = sides(secret) as Side[];
  expect(masked?.kind).toBe("Secret");
  expect(masked?.data).toEqual({
    "key.der": "<10 bytes>",
    password: "<13 bytes>",
  });
  expect(changed?.data).toEqual({
    "key.der": "<10 bytes>",
    password: "<17 bytes>",
  });
});

test("a delete refuses a context name typed wrong, an ask that is gone, and allows the right one", async () => {
  const { backend, events } = await followed("approval");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  await answer(backend, nth(events, 0));
  await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  await answer(backend, nth(events, 1));
  await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  const remove = nth(events, 2);
  expect(remove).toMatchObject({
    typed: true,
    lastingMinutes: null,
    context: "prod-eu",
  });

  for (const typed of [null, "prod", "Prod-eu"]) {
    const error = await answer(backend, remove, { kind: "once" }, typed);
    expect(error).toBeInstanceOf(IpcError);
    expect((error as IpcError).kind).toBe("invalidInput");
  }
  expect(
    await answer(backend, remove, { kind: "lasting" }, "prod"),
  ).toBeInstanceOf(IpcError);
  expect(
    await answer(backend, remove, { kind: "once" }, "prod-eu"),
  ).toBeUndefined();

  const gone = await answer(backend, remove, { kind: "once" }, "prod-eu");
  expect((gone as IpcError).kind).toBe("notFound");
});

async function throughSequence(
  backend: Backend,
  events: ApprovalEvent[],
  lastingAt?: number,
) {
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  for (let step = 0; asks(events).length > step; step++) {
    const ask = nth(events, step);
    await answer(
      backend,
      ask,
      step === lastingAt ? { kind: "lasting" } : { kind: "once" },
      ask.context,
    );
    await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  }
}

test("a lasting answer spares its process and context the asks that come after, and no other process", async () => {
  const lasting = await followed("approval");
  await throughSequence(lasting.backend, lasting.events, 0);
  expect(asks(lasting.events).map(({ command }) => command)).toEqual([
    "kubectl set image",
    "kubectl create",
    "kubectl delete",
    "kubectl scale",
    "kubectl apply",
    "kubectl annotate",
    "kubectl edit",
    "kubectl delete",
  ]);
  expect(
    asks(lasting.events)
      .slice(1)
      .map(({ process }) => process),
  ).not.toContain("Terminal 2");

  const once = await followed("approval");
  await throughSequence(once.backend, once.events);
  expect(asks(once.events)).toHaveLength(10);
});

test("a lasting answer spares the writes of its process and context, and a delete of theirs still asks", async () => {
  const { backend, events } = await followed("approval");
  await throughSequence(backend, events, 1);
  expect(
    asks(events)
      .filter(
        ({ process, context }) =>
          process === "Terminal 1" && context === "staging",
      )
      .map(({ verb, target, typed }) => ({ verb, target, typed })),
  ).toEqual([
    {
      verb: "create",
      target: "configmaps/feature-flags in default",
      typed: false,
    },
    {
      verb: "delete",
      target: "configmaps/feature-flags in default",
      typed: true,
    },
  ]);
});

test("a lasting answer ends after the minutes the ask offered, and the delete in prod-eu, relocked by then, is refused with no ask", async () => {
  const { backend, events } = await followed("approval");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  const patch = nth(events, 0);
  await answer(backend, patch, { kind: "lasting" });
  await vi.advanceTimersByTimeAsync((patch.lastingMinutes ?? 0) * 60_000);
  await answer(backend, nth(events, 1));
  await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  expect(nth(events, 2)).toMatchObject({
    command: "kubectl exec",
    context: "staging",
  });
});

test("a lasting answer allows the asks of its process and context that already wait, and withdraws them", async () => {
  const { backend, events } = await followed("approvalQueue");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  const [patch, create, exec] = [
    nth(events, 0),
    nth(events, 1),
    nth(events, 2),
  ];
  expect([patch.process, create.process, exec.process]).toEqual([
    "Terminal 2",
    "Terminal 1",
    "Terminal 2",
  ]);

  expect(await answer(backend, patch, { kind: "lasting" })).toBeUndefined();
  expect(events.slice(3)).toEqual([{ event: "withdrawn", id: exec.id }]);
  const gone = await answer(backend, exec);
  expect((gone as IpcError).kind).toBe("notFound");
  expect(await answer(backend, create)).toBeUndefined();
});

test("a lasting answer is refused for an ask that offers none, and the ask stays", async () => {
  const { backend, events } = await followed("approval");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  await answer(backend, nth(events, 0));
  await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  await answer(backend, nth(events, 1));
  await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  const remove = nth(events, 2);
  expect(remove.lastingMinutes).toBeNull();

  const refused = await answer(backend, remove, { kind: "lasting" }, "prod-eu");
  expect((refused as IpcError).kind).toBe("invalidInput");
  expect(
    await answer(backend, remove, { kind: "once" }, "prod-eu"),
  ).toBeUndefined();
});

test("a deny needs no name typed", async () => {
  const { backend, events } = await followed("approval");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  await answer(backend, nth(events, 0));
  await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  await answer(backend, nth(events, 1));
  await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  expect(nth(events, 2).typed).toBe(true);
  expect(
    await answer(backend, nth(events, 2), { kind: "deny" }),
  ).toBeUndefined();
});

const MARK: ApprovalAnswer = { kind: "mark", environment: "staging" };

const typeOf = async (backend: Backend, context: string) => {
  const watch = backend.subscribe("contexts_watch", null, () => undefined);
  await vi.advanceTimersByTimeAsync(0);
  const contexts = await watch;
  return contexts.find(({ name }) => name === context)?.access.environment;
};

test("an ask of a context nobody marked takes its type or a denial alone, and its type answers no ordinary ask", async () => {
  const { backend, events } = await followed("approvalUnmarked");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  const unmarked = nth(events, 0);
  expect(unmarked).toMatchObject({ context: "qa", unmarked: true });
  for (const given of [{ kind: "once" }, { kind: "lasting" }] as const) {
    const error = await answer(backend, unmarked, given);
    expect((error as IpcError).kind).toBe("invalidInput");
  }
  expect(await typeOf(backend, "qa")).toBeNull();
  expect(await answer(backend, unmarked, { kind: "deny" })).toBeUndefined();
  expect(await typeOf(backend, "qa")).toBeNull();

  const ordinary = await followed("approval");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  const patch = nth(ordinary.events, 0);
  const refused = await answer(ordinary.backend, patch, MARK);
  expect((refused as IpcError).kind).toBe("invalidInput");
  expect(await answer(ordinary.backend, patch)).toBeUndefined();
});

test("a type that answers an unmarked ask marks its context, and Staging raises the request again as an ordinary ask", async () => {
  const staging = await followed("approvalUnmarked");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  const unmarked = nth(staging.events, 0);
  expect(await answer(staging.backend, unmarked, MARK)).toBeUndefined();
  expect(await typeOf(staging.backend, "qa")).toBe("staging");
  const again = nth(staging.events, 1);
  expect(again).toMatchObject({
    context: "qa",
    process: unmarked.process,
    target: unmarked.target,
    unmarked: false,
    lastingMinutes: 15,
  });
  expect(again.id).not.toBe(unmarked.id);

  const production = await followed("approvalUnmarked");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  await answer(production.backend, nth(production.events, 0), {
    kind: "mark",
    environment: "production",
  });
  await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  expect(await typeOf(production.backend, "qa")).toBe("production");
  expect(asks(production.events)).toHaveLength(1);
});

const choose = (backend: Backend, request: Parameters<typeof protect>[1]) =>
  protect(backend, request, () => vi.advanceTimersByTimeAsync(1));

test("a delete's unmarked ask asks for no name and offers no 15 minutes, and the ordinary ask Staging raises for it asks for the name and offers none", async () => {
  const { backend, events } = await followed("approval");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  await answer(backend, nth(events, 0));
  await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  await answer(backend, nth(events, 1));
  await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  const remove = nth(events, 2);
  expect(remove).toMatchObject({ context: "prod-eu", verb: "delete" });
  await choose(backend, {
    action: "setEnvironment",
    context: "prod-eu",
    environment: null,
  });
  const unmarked = nth(events, 3);
  expect(unmarked).toMatchObject({
    context: "prod-eu",
    target: remove.target,
    unmarked: true,
    typed: false,
    lastingMinutes: null,
  });
  expect(await answer(backend, unmarked, MARK)).toBeUndefined();
  expect(nth(events, 4)).toMatchObject({
    context: "prod-eu",
    target: remove.target,
    unmarked: false,
    typed: true,
    lastingMinutes: null,
  });
});

test("an ordinary ask whose context is made read-only is withdrawn and its request refused, and one whose type is cleared asks what the context is", async () => {
  const refused = await followed("approval");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  const patch = nth(refused.events, 0);
  await choose(refused.backend, {
    action: "setMode",
    context: "staging",
    mode: "read-only",
  });
  expect(refused.events.slice(1)).toEqual([
    { event: "withdrawn", id: patch.id },
  ]);

  const cleared = await followed("approval");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  const create = nth(cleared.events, 0);
  await choose(cleared.backend, {
    action: "setEnvironment",
    context: "staging",
    environment: null,
  });
  expect(cleared.events[1]).toEqual({ event: "withdrawn", id: create.id });
  expect(asks(cleared.events)[1]).toMatchObject({
    context: "staging",
    unmarked: true,
    lastingMinutes: null,
    process: create.process,
    target: create.target,
  });
});

test("a window that follows again is sent the asks that wait", async () => {
  const { backend, events } = await followed("approvalQueue");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  expect(asks(events)).toHaveLength(3);

  const again: ApprovalEvent[] = [];
  void backend.subscribe("approvals_watch", null, (event) => {
    again.push(event);
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(asks(again).map(({ id }) => id)).toEqual(
    asks(events).map(({ id }) => id),
  );
});

test("the queue raises three asks at once and no more", async () => {
  const { events } = await followed("approvalQueue");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS - 1);
  expect(asks(events)).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(asks(events).map(({ process }) => process)).toEqual([
    "Terminal 2",
    "Terminal 1",
    "Terminal 2",
  ]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(asks(events)).toHaveLength(3);
});

test("a withdrawn ask is withdrawn a while after it shows, unless it was answered", async () => {
  const left = await followed("approvalWithdrawn");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  const ask = nth(left.events, 0);
  await vi.advanceTimersByTimeAsync(WITHDRAWN_AFTER_MS - 1);
  expect(left.events.map(({ event }) => event)).toEqual(["asked"]);
  await vi.advanceTimersByTimeAsync(1);
  expect(left.events[1]).toEqual({ event: "withdrawn", id: ask.id });
  const gone = await answer(left.backend, ask);
  expect((gone as IpcError).kind).toBe("notFound");

  const answered = await followed("approvalWithdrawn");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  await answer(answered.backend, nth(answered.events, 0));
  await vi.advanceTimersByTimeAsync(2 * WITHDRAWN_AFTER_MS);
  expect(answered.events.map(({ event }) => event)).toEqual(["asked"]);
});

test("another scenario raises nothing", async () => {
  const { events } = await followed("ready");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(events).toEqual([]);
});

test("a lasting answer ends once its context goes read-only and back", async () => {
  const { backend, events } = await followed("approval");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  await answer(backend, nth(events, 0), { kind: "lasting" });
  await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  await answer(backend, last(events));
  await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  const remove = last(events);
  await choose(backend, {
    action: "setMode",
    context: "staging",
    mode: "read-only",
  });
  await choose(backend, { action: "setMode", context: "staging", mode: null });
  await answer(backend, remove, { kind: "deny" });
  await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  expect(last(events)).toMatchObject({
    process: "Terminal 2",
    context: "staging",
    command: "kubectl exec",
  });
});

test("an unmarked ask answered Staging asks to allow the request, whatever the process was allowed before the type was cleared", async () => {
  const { backend, events } = await followed("approval");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  await answer(backend, nth(events, 0), { kind: "lasting" });
  await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  await answer(backend, last(events));
  await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  const remove = last(events);
  await choose(backend, {
    action: "setEnvironment",
    context: "staging",
    environment: null,
  });
  await answer(backend, remove, { kind: "deny" });
  await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  const exec = last(events);
  expect(exec).toMatchObject({
    process: "Terminal 2",
    context: "staging",
    unmarked: true,
  });
  expect(
    await answer(backend, exec, { kind: "mark", environment: "staging" }),
  ).toBeUndefined();
  expect(last(events)).toMatchObject({
    process: "Terminal 2",
    context: "staging",
    unmarked: false,
    lastingMinutes: 15,
  });
});
