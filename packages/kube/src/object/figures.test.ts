import { expect, test } from "vitest";
import type { Measure } from "@twigo/protocol";
import { figure, hasUsage } from "./figures";

const MI = 1024 * 1024;

function measure(rest: Partial<Measure>): Measure {
  return { used: null, request: null, limit: null, allocatable: null, ...rest };
}

test("a pod and a node have a usage, and nothing else does", () => {
  const gvr = (group: string, resource: string) => ({
    group,
    version: "v1",
    resource,
  });
  expect(hasUsage(gvr("", "pods"))).toBe(true);
  expect(hasUsage(gvr("", "nodes"))).toBe(true);
  expect(hasUsage(gvr("apps", "deployments"))).toBe(false);
  expect(hasUsage(gvr("example.com", "pods"))).toBe(false);
});

test("a measure is held against what a node can allocate, else its limit, else its request", () => {
  const all = { used: 10, request: 20, limit: 40, allocatable: 80 };
  expect(figure("memory", measure(all)).base).toBe("allocatable");
  expect(figure("memory", measure({ ...all, allocatable: null })).base).toBe(
    "limit",
  );
  expect(
    figure("memory", measure({ ...all, allocatable: null, limit: null })).base,
  ).toBe("request");
  expect(figure("memory", measure({ used: 10 })).base).toBeNull();
});

test("a node's percent is kubectl's: truncated, in thousandths with a CPU rounded up, and past 100 where it passes", () => {
  const cpu = (used: number) =>
    figure("cpu", measure({ used, allocatable: 64_000_000_000 }));
  expect(cpu(68_919_000_000).percent).toBe(107);
  expect(
    figure("cpu", measure({ used: 277_147_502, allocatable: 16e9 })).percent,
  ).toBe(1);
  expect(
    figure(
      "memory",
      measure({ used: 2_509_700 * 1024, allocatable: 16_355_060 * 1024 }),
    ).percent,
  ).toBe(15);
  expect(figure("memory", measure({ used: 999, limit: 1000 })).percent).toBe(
    99,
  );
});

test("a measure is a warning from 90 % of its limit and an error at it, and never against a request", () => {
  const memory = (used: number, rest: Partial<Measure> = { limit: 100 * MI }) =>
    figure("memory", measure({ used: used * MI, ...rest })).tone;
  expect(memory(89)).toBeUndefined();
  expect(memory(90)).toBe("warn");
  expect(memory(99)).toBe("warn");
  expect(memory(100)).toBe("error");
  expect(memory(130)).toBe("error");
  expect(memory(500, { request: 100 * MI })).toBeUndefined();
  expect(memory(95, { allocatable: 100 * MI })).toBe("warn");
});

test("no sample is no figure at all: no text, no bar, no percent", () => {
  expect(figure("cpu", measure({ limit: 400_000_000 }))).toMatchObject({
    used: null,
    percent: null,
    tone: undefined,
    bar: null,
    limit: "400m",
  });
  expect(figure("memory", measure({ used: 0, limit: 64 * MI }))).toMatchObject({
    used: "0Mi",
    percent: 0,
  });
});

test("a bar is the whole of its limit with the request marked, and of a little past its request where there is no limit", () => {
  expect(
    figure(
      "memory",
      measure({ used: 30 * MI, request: 16 * MI, limit: 64 * MI }),
    ).bar,
  ).toEqual({ value: 30 * MI, max: 64 * MI, mark: 16 * MI });
  expect(
    figure("memory", measure({ used: 10 * MI, request: 16 * MI })).bar,
  ).toEqual({ value: 10 * MI, max: 20 * MI, mark: 16 * MI });
  expect(
    figure("memory", measure({ used: 30 * MI, request: 16 * MI })).bar?.max,
  ).toBe(37.5 * MI);
  expect(figure("memory", measure({ used: 5 * MI })).bar).toBeNull();
});
