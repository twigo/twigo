import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockBackend } from "./mock";
import { ReleaseView } from "./release";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const ref = { space: "prod-eu", namespace: "payments", name: "alpha" };
const ALL = { overview: true, values: true, manifest: true, history: true };

async function later(ms = 50) {
  await vi.advanceTimersByTimeAsync(ms);
}

test("a part stays while its revision is shown, and never stands beside another revision's", async () => {
  const view = new ReleaseView(createMockBackend(), ref, {
    revision: null,
    parts: ALL,
  });
  await later();
  const latest = view.getSnapshot();
  expect(latest.revision).toBe(2);
  expect(latest.values?.user).toBeDefined();
  expect(latest.history?.map((line) => line.revision)).toEqual([2, 1]);

  view.setAsk({ revision: null, parts: { ...ALL, values: false } });
  await later();
  expect(view.getSnapshot().values).toBe(latest.values);

  view.setAsk({
    revision: 1,
    parts: { overview: true, values: false, manifest: false, history: false },
  });
  await later();
  const pinned = view.getSnapshot();
  expect(pinned.revision).toBe(1);
  expect(pinned.overview).toBeDefined();
  expect(pinned.overview).not.toBe(latest.overview);
  expect(pinned.values).toBeUndefined();
  expect(pinned.manifest).toBeUndefined();
  expect(pinned.history).toBe(latest.history);
  expect(pinned.epoch).not.toBe(latest.epoch);
  expect(pinned.life).toBe(latest.life);
  view.close();
});

test("a release that is gone has no parts, and a revision it does not keep says so with the latest", async () => {
  const gone = new ReleaseView(
    createMockBackend(),
    { ...ref, name: "nothing" },
    { revision: null, parts: ALL },
  );
  await later();
  expect(gone.getSnapshot().exists).toBe(false);
  expect(gone.getSnapshot().overview).toBeUndefined();
  gone.close();

  const pinnedGone = new ReleaseView(
    createMockBackend(),
    { ...ref, name: "nothing" },
    { revision: 3, parts: ALL },
  );
  await later();
  expect(pinnedGone.getSnapshot().exists).toBe(false);
  expect(pinnedGone.getSnapshot().revision).toBeUndefined();
  expect(pinnedGone.getSnapshot().problem).toBeUndefined();
  pinnedGone.close();

  const again = new ReleaseView(createMockBackend(), ref, {
    revision: null,
    parts: ALL,
  });
  await later();
  const first = new ReleaseView(createMockBackend(), ref, {
    revision: null,
    parts: ALL,
  });
  await later();
  expect(again.getSnapshot().life).not.toBe(first.getSnapshot().life);
  again.close();
  first.close();

  const pinned = new ReleaseView(createMockBackend(), ref, {
    revision: 9,
    parts: ALL,
  });
  await later();
  expect(pinned.getSnapshot().problem?.code).toBe("helm.revision-gone");
  expect(pinned.getSnapshot().latest).toBe(2);
  pinned.close();
});
