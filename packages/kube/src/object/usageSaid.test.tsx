import { renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import type { Measure, MetricsState, ShownUsage } from "@twigo/protocol";
import { UsageSaid, useDrawnUsage } from "./usageSaid";

const NOTHING: Measure = {
  used: null,
  request: null,
  limit: null,
  allocatable: null,
};

function usage(
  state: ShownUsage["state"],
  waiting = false,
  containers: ShownUsage["containers"] = [],
): ShownUsage {
  return {
    state,
    waiting,
    sampled: null,
    cpu: NOTHING,
    memory: NOTHING,
    containers,
  };
}

function drawn(said: UsageSaid, next: ShownUsage | undefined) {
  return renderHook(() => useDrawnUsage(said, "prod-eu", next)).result.current;
}

function saying(space: string, state: MetricsState): UsageSaid {
  const said = new UsageSaid();
  said.say(space, state);
  return said;
}

test("a usage that waits is drawn as it is, until the space's API has said a refusal", () => {
  const waiting = usage("ready", true);
  expect(drawn(new UsageSaid(), waiting)).toBe(waiting);
  expect(drawn(saying("prod-eu", "ready"), waiting)).toBe(waiting);
});

test.each(["unavailable", "forbidden"] as const)(
  "a usage that waits draws what the space's API last said, %s, as its sentence and no rows",
  (state) => {
    const waiting = usage("ready", true, [
      { name: "api", cpu: NOTHING, memory: NOTHING },
    ]);
    expect(drawn(saying("prod-eu", state), waiting)).toMatchObject({
      state,
      waiting: false,
      containers: [],
    });
    expect(drawn(saying("staging", state), waiting)).toBe(waiting);
  },
);

test("a usage that came is drawn as it is, and said for the space's next object", () => {
  const said = saying("prod-eu", "forbidden");
  const came = usage("ready");
  expect(drawn(said, came)).toBe(came);
  expect(said.get("prod-eu")).toBe("ready");
  const refused = usage("forbidden");
  expect(drawn(said, refused)).toBe(refused);
  expect(said.get("prod-eu")).toBe("forbidden");
  expect(said.get("staging")).toBeUndefined();
});

test("a usage that waits says nothing of the space, and no usage draws none", () => {
  const said = saying("prod-eu", "forbidden");
  drawn(said, usage("ready", true));
  expect(said.get("prod-eu")).toBe("forbidden");
  expect(drawn(said, undefined)).toBeUndefined();
  const waiting = usage("ready", true);
  expect(
    renderHook(() => useDrawnUsage(said, undefined, waiting)).result.current,
  ).toBe(waiting);
});
