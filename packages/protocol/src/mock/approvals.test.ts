import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { IpcError } from "../error";
import type { Backend } from "../backend";
import type { ApprovalAsk, ApprovalEvent } from "../generated";
import {
  createMockBackend,
  FIRST_ASK_MS,
  NEXT_ASK_MS,
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

async function answer(
  backend: Backend,
  ask: ApprovalAsk,
  answer: "deny" | "once" | "lasting" = "once",
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

  for (let step = 1; step < 9; step++) {
    await answer(backend, nth(events, step), "deny", "prod-eu");
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
  ]);
  expect(asks(events)[7]?.impersonate).toBe(
    "system:serviceaccount:default:deployer",
  );
});

async function raised(): Promise<ApprovalAsk[]> {
  const { backend, events } = await followed("approval");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  for (let step = 0; step < 9; step++) {
    await answer(backend, nth(events, step), "deny", "prod-eu");
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
  ]);
});

test("a diff's sides are recorded objects with a change made in code, as Rust's side sends them", async () => {
  const { backend, events } = await followed("approval");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  for (let step = 0; step < 9; step++) {
    await answer(backend, nth(events, step), "deny", "prod-eu");
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
    const error = await answer(backend, remove, "once", typed);
    expect(error).toBeInstanceOf(IpcError);
    expect((error as IpcError).kind).toBe("invalidInput");
  }
  expect(await answer(backend, remove, "lasting", "prod")).toBeInstanceOf(
    IpcError,
  );
  expect(await answer(backend, remove, "once", "prod-eu")).toBeUndefined();

  const gone = await answer(backend, remove, "once", "prod-eu");
  expect((gone as IpcError).kind).toBe("notFound");
});

test("a deny needs no name typed", async () => {
  const { backend, events } = await followed("approval");
  await vi.advanceTimersByTimeAsync(FIRST_ASK_MS);
  await answer(backend, nth(events, 0));
  await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  await answer(backend, nth(events, 1));
  await vi.advanceTimersByTimeAsync(NEXT_ASK_MS);
  expect(nth(events, 2).typed).toBe(true);
  expect(await answer(backend, nth(events, 2), "deny")).toBeUndefined();
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
