import { renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  INITIAL_OBJECT,
  type MetricsState,
  type ObjectSnapshot,
  type Resource,
  type ShownUsage,
} from "@twigo/protocol";
import RESOURCES from "../../../protocol/src/mock/resources.json";
import type { Loaded } from "../discovery";
import { useExpectedUsage } from "./expectedUsage";
import { UsageSaid } from "./usageSaid";

const PODS = { group: "", version: "v1", resource: "pods" };
const SERVING: Loaded<readonly Resource[]> = {
  state: "ready",
  value: RESOURCES,
};
const WITHOUT: Loaded<readonly Resource[]> = {
  state: "ready",
  value: RESOURCES.filter(({ gvr }) => gvr.group !== "metrics.k8s.io"),
};

function expected(
  rest: {
    said?: UsageSaid;
    resources?: Loaded<readonly Resource[]>;
    asked?: boolean;
    snapshot?: Partial<ObjectSnapshot>;
  } = {},
) {
  return renderHook(() =>
    useExpectedUsage({
      said: rest.said ?? new UsageSaid(),
      space: "prod-eu",
      gvr: PODS,
      resources: rest.resources ?? SERVING,
      asked: rest.asked ?? true,
      snapshot: { ...INITIAL_OBJECT, ...rest.snapshot },
    }),
  ).result.current;
}

function said(state: MetricsState) {
  const memory = new UsageSaid();
  memory.say("prod-eu", state);
  return memory;
}

test("nothing has come where the usage is asked for and served: the figures' place, until something is said", () => {
  expect(expected()).toBe("loading");
  expect(expected({ said: said("ready") })).toBe("loading");
});

test.each(["unavailable", "forbidden"] as const)(
  "what the space's API last said, %s, is expected at once",
  (state) => {
    expect(expected({ said: said(state) })).toBe(state);
  },
);

test("after an absent, of this object or of the space, nothing is expected", () => {
  expect(expected({ said: said("absent") })).toBeUndefined();
  expect(expected({ snapshot: { usageState: "absent" } })).toBeUndefined();
});

test("the object's own last word comes before the space's", () => {
  expect(
    expected({ said: said("absent"), snapshot: { usageState: "forbidden" } }),
  ).toBe("forbidden");
});

test("a usage that came, a part not asked for and a context that does not serve the resource expect nothing", () => {
  expect(
    expected({ snapshot: { usage: { state: "ready" } as ShownUsage } }),
  ).toBeUndefined();
  expect(expected({ asked: false })).toBeUndefined();
  expect(expected({ resources: WITHOUT })).toBeUndefined();
  expect(expected({ resources: { state: "loading" } })).toBeUndefined();
});

test("what an object brings is kept for the space's next object", () => {
  const memory = new UsageSaid();
  renderHook(() =>
    useExpectedUsage({
      said: memory,
      space: "prod-eu",
      gvr: PODS,
      resources: SERVING,
      asked: true,
      snapshot: { ...INITIAL_OBJECT, usageState: "forbidden" },
    }),
  );
  expect(memory.get("prod-eu")).toBe("forbidden");
  expect(memory.get("staging")).toBeUndefined();
});
