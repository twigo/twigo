import { renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import type { Measure, Resource, ShownUsage } from "@twigo/protocol";
import type { Loaded } from "../discovery";
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

function discovered(): Loaded<readonly Resource[]> {
  return { state: "ready", value: [] };
}

function memory(...spaces: string[]) {
  const answered = new Map(spaces.map((space) => [space, discovered()]));
  return {
    answered,
    said: new UsageSaid({ last: (space) => answered.get(space) }),
  };
}

function drawn(said: UsageSaid, next: ShownUsage | undefined) {
  return renderHook(() => useDrawnUsage(said, "prod-eu", next)).result.current;
}

test("a usage that waits is drawn as it is, until the space's API has refused the person", () => {
  const { said } = memory("prod-eu");
  const waiting = usage("ready", true);
  expect(drawn(said, waiting)).toBe(waiting);
  said.say("prod-eu", "ready");
  expect(drawn(said, waiting)).toBe(waiting);
});

test("a usage that waits draws the refusal's sentence and no rows where the space refused, and not for another space", () => {
  const { said } = memory("prod-eu", "staging");
  const waiting = usage("ready", true, [
    { name: "api", cpu: NOTHING, memory: NOTHING },
  ]);
  said.say("prod-eu", "forbidden");
  expect(drawn(said, waiting)).toMatchObject({
    state: "forbidden",
    waiting: false,
    containers: [],
  });
  const other = renderHook(() => useDrawnUsage(said, "staging", waiting));
  expect(other.result.current).toBe(waiting);
});

test("a refusal is remembered by the usage that says it, and forgotten by any other state", () => {
  const { said } = memory("prod-eu");
  const waiting = usage("ready", true);
  const refused = usage("forbidden");
  expect(drawn(said, refused)).toBe(refused);
  expect(drawn(said, waiting)).toMatchObject({ state: "forbidden" });
  for (const state of ["ready", "unavailable"] as const) {
    drawn(said, usage("forbidden"));
    drawn(said, usage(state));
    expect(drawn(said, waiting)).toBe(waiting);
  }
});

test("a usage that waits says nothing of the space, and no usage draws none", () => {
  const { said } = memory("prod-eu");
  said.say("prod-eu", "forbidden");
  drawn(said, usage("ready", true));
  expect(said.refused("prod-eu")).toBe(true);
  expect(drawn(said, undefined)).toBeUndefined();
});

test("a new discovery of the space forgets the refusal, and so does a space whose discovery has not answered", () => {
  const { said, answered } = memory("prod-eu");
  const waiting = usage("ready", true);
  said.say("prod-eu", "forbidden");
  expect(drawn(said, waiting)).toMatchObject({ state: "forbidden" });
  answered.set("prod-eu", discovered());
  expect(drawn(said, waiting)).toBe(waiting);
  said.say("prod-eu", "forbidden");
  expect(said.refused("prod-eu")).toBe(true);
  answered.delete("prod-eu");
  expect(said.refused("prod-eu")).toBe(false);
  said.say("prod-eu", "forbidden");
  answered.set("prod-eu", discovered());
  expect(said.refused("prod-eu")).toBe(false);
});
