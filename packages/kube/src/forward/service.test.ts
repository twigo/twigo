import { expect, test, vi } from "vitest";
import type {
  Backend,
  Forward,
  ForwardEvent,
  ForwardState,
} from "@twigo/protocol";
import { Forwards } from "./service";

function forward(
  id: number,
  space = "dev",
  state: ForwardState = { state: "ready" },
): Forward {
  return {
    id,
    target: {
      space,
      gvr: { group: "", version: "v1", resource: "services" },
      namespace: "default",
      name: "web",
    },
    kind: "Service",
    port: 80,
    portName: "http",
    appProtocol: null,
    local: 8080 + id,
    addresses: ["127.0.0.1"],
    state,
    pod: null,
    podPort: null,
    connections: 0,
    queued: 0,
    sent: 0,
    received: 0,
    failure: null,
  };
}

/** A backend whose watch answers when the test says, and whose events the test sends. */
function watched() {
  let send: (event: ForwardEvent) => void = () => undefined;
  let answer: (list: Forward[]) => void = () => undefined;
  const subscribe = vi.fn(
    (_command: string, _request: unknown, onMessage: typeof send) => {
      send = onMessage;
      return new Promise<Forward[]>((resolve) => {
        answer = resolve;
      });
    },
  );
  const forwards = new Forwards({ subscribe } as unknown as Backend);
  const loading = forwards.watch();
  return {
    forwards,
    subscribe,
    event: (event: ForwardEvent) => {
      send(event);
    },
    answer: async (list: Forward[]) => {
      answer(list);
      await loading;
    },
  };
}

const changed = (next: Forward): ForwardEvent => ({
  event: "changed",
  forward: next,
});

test("it holds the first list by id, a space's in the order they were made, and says when it has come", async () => {
  const { forwards, answer } = watched();
  expect(forwards.loaded).toBe(false);
  await answer([forward(3), forward(1), forward(2, "qa")]);
  expect(forwards.loaded).toBe(true);
  expect(forwards.get(2)?.target.space).toBe("qa");
  expect(forwards.ofSpace("dev").map(({ id }) => id)).toEqual([1, 3]);
  expect(forwards.ofSpace("qa").map(({ id }) => id)).toEqual([2]);
  expect(forwards.ofSpace("staging")).toEqual([]);
});

test("a Changed event adds or replaces a forward and a Removed event drops it, each telling its readers", async () => {
  const { forwards, answer, event } = watched();
  await answer([forward(1)]);
  const before = forwards.changes.version;
  const space = forwards.ofSpace("dev");

  event(changed(forward(2)));
  expect(forwards.ofSpace("dev").map(({ id }) => id)).toEqual([1, 2]);
  expect(forwards.ofSpace("dev")).not.toBe(space);

  event(changed({ ...forward(1), local: 9000 }));
  expect(forwards.get(1)?.local).toBe(9000);

  event({ event: "removed", id: 2 });
  expect(forwards.get(2)).toBeUndefined();
  expect(forwards.ofSpace("dev").map(({ id }) => id)).toEqual([1]);
  expect(forwards.changes.version).toBe(before + 3);
  expect(forwards.ofSpace("dev")).toBe(forwards.ofSpace("dev"));
});

test("an event that comes before the list is newer than the list and is kept", async () => {
  const { forwards, answer, event } = watched();
  event(changed({ ...forward(1), local: 9000 }));
  event({ event: "removed", id: 2 });
  event(changed(forward(4)));
  await answer([forward(1), forward(2), forward(3)]);
  expect(forwards.get(1)?.local).toBe(9000);
  expect(forwards.get(2)).toBeUndefined();
  expect(forwards.get(3)).toBeDefined();
  expect(forwards.get(4)).toBeDefined();

  event(changed(forward(2)));
  expect(forwards.get(2)).toBeDefined();
});

test("it watches the window's forwards once, with no request", () => {
  const { subscribe } = watched();
  expect(subscribe).toHaveBeenCalledOnce();
  expect(subscribe.mock.calls[0]?.slice(0, 2)).toEqual([
    "forwards_watch",
    null,
  ]);
});

test("settled of an answer that is final settles at once", async () => {
  const { forwards, answer } = watched();
  await answer([]);
  const ready = forward(1, "dev", { state: "ready" });
  await expect(forwards.settled(ready)).resolves.toBe(ready);
});

test("settled of a start waits for the first change that leaves starting, and tells how it went", async () => {
  const { forwards, answer, event } = watched();
  await answer([]);
  const starting = forward(1, "dev", { state: "starting" });
  event(changed(starting));
  const settled = vi.fn();
  void forwards.settled(starting).then(settled);
  event(changed({ ...starting, pod: "web-1" }));
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  event(changed(forward(1, "dev", { state: "reconnecting", reason: "x" })));
  await vi.waitFor(() => {
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({
        state: { state: "reconnecting", reason: "x" },
      }),
    );
  });
});

test("settled of a start does not take the state an earlier run left for its own", async () => {
  const { forwards, answer, event } = watched();
  const failed = forward(1, "dev", {
    state: "failed",
    error: { kind: "unavailable", message: "refused" },
  });
  await answer([failed]);
  const settled = vi.fn();
  void forwards
    .settled({ ...failed, state: { state: "starting" } })
    .then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  event(changed(forward(1, "dev", { state: "ready" })));
  await vi.waitFor(() => {
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ state: { state: "ready" } }),
    );
  });
});

test("settled of a start that the core removes settles with nothing", async () => {
  const { forwards, answer, event } = watched();
  await answer([]);
  const starting = forward(8, "dev", { state: "starting" });
  event(changed(starting));
  const gone = vi.fn();
  void forwards.settled(starting).then(gone);
  event({ event: "removed", id: 8 });
  await vi.waitFor(() => {
    expect(gone).toHaveBeenCalledWith(undefined);
  });
});

test("a space's selected forward is held while it exists", async () => {
  const { forwards, answer, event } = watched();
  await answer([forward(1), forward(2, "qa")]);
  expect(forwards.selected("dev")).toBeUndefined();
  forwards.select("dev", 1);
  forwards.select("qa", 1);
  expect(forwards.selected("dev")).toBe(1);
  expect(forwards.selected("qa")).toBeUndefined();
  event({ event: "removed", id: 1 });
  expect(forwards.selected("dev")).toBeUndefined();
});
