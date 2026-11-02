import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  Backend,
  ObjectBatch,
  ObjectQuery,
  Overview,
} from "@twigo/protocol";
import { useObject } from "./useObject";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const A: ObjectQuery = {
  space: "s",
  gvr: { group: "", version: "v1", resource: "pods" },
  namespaced: true,
  namespace: "payments",
  name: "a",
};

const PARTS = {
  overview: true,
  manifest: false,
  events: false,
  related: false,
};

function document(name: string): Overview {
  return { sections: [{ id: name, title: name, blocks: [] }] };
}

/** A backend whose opens answer with an id at once and send a batch when told to. */
function backend() {
  const sends: ((batch: ObjectBatch) => void)[] = [];
  const closed: number[] = [];
  const fake: Backend = {
    invoke(command, request) {
      if (command === "object_close") closed.push(request as number);
      return Promise.resolve(null as never);
    },
    subscribe(_command, _request, onMessage) {
      sends.push(onMessage);
      return Promise.resolve(sends.length as never);
    },
  };
  const send = (index: number, name: string) => {
    act(() => {
      sends[index]?.({
        seq: 1,
        status: { state: "ready" },
        exists: true,
        overview: document(name),
        manifest: null,
        events: null,
        related: null,
      });
    });
  };
  return { fake, closed, send };
}

test("an object opened again shows nothing of the view it closed", async () => {
  const { fake, closed, send } = backend();
  const { result, rerender } = renderHook<
    ReturnType<typeof useObject>,
    { query: ObjectQuery | undefined }
  >(({ query }) => useObject(fake, query, PARTS), {
    initialProps: { query: A },
  });
  await act(() => vi.runAllTimersAsync());
  send(0, "first view");
  expect(result.current.snapshot.overview?.sections[0]?.id).toBe("first view");

  rerender({ query: undefined });
  rerender({ query: { ...A } });
  await act(() => vi.runAllTimersAsync());
  expect(closed).toContain(1);
  expect(result.current.snapshot.overview).toBeUndefined();
  expect(result.current.values).toBeUndefined();
  send(1, "second view");
  expect(result.current.snapshot.overview?.sections[0]?.id).toBe("second view");
});
