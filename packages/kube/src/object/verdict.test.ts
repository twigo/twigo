import { expect, test } from "vitest";
import type { Gvr, Printed } from "@twigo/protocol";
import { verdictOf } from "./verdict";

const gvr = (group: string, resource: string): Gvr => ({
  group,
  version: "v1",
  resource,
});
const printed = (...cells: [string, string][]): Printed[] =>
  cells.map(([column, value]) => ({ column, value }));
const read = (cells: Printed[]) => (column: string) =>
  cells.find((cell) => cell.column === column)?.value;

test("a pod's word is its Status, toned by the list's rule", () => {
  const pod = gvr("", "pods");
  const cells = printed(["Ready", "0/1"], ["Status", "CrashLoopBackOff"]);
  expect(verdictOf(pod, read(cells))).toEqual({
    word: "CrashLoopBackOff",
    tone: "error",
    finished: false,
  });
  expect(verdictOf(pod, read(printed(["Status", "Running"])))).toEqual({
    word: "Running",
    tone: undefined,
    finished: false,
  });
  expect(verdictOf(pod, read(printed(["Status", "Pending"])))?.tone).toBe(
    "warn",
  );
});

test("a pod that ran to completion says so, so that its restarts are no news", () => {
  expect(
    verdictOf(gvr("", "pods"), read(printed(["Status", "Completed"]))),
  ).toEqual({ word: "Completed", tone: undefined, finished: true });
});

test("a Deployment's word is its Ready, the column its list is held to, and a short one is pending", () => {
  const deployment = gvr("apps", "deployments");
  expect(
    verdictOf(deployment, read(printed(["Ready", "42/43"]))),
  ).toMatchObject({ word: "42/43", tone: "warn" });
  expect(verdictOf(deployment, read(printed(["Ready", "2/2"])))).toMatchObject({
    word: "2/2",
    tone: undefined,
  });
});

test("a node that is not ready fails", () => {
  expect(
    verdictOf(gvr("", "nodes"), read(printed(["Status", "NotReady"]))),
  ).toMatchObject({ tone: "error" });
});

test("a kind whose list has no health column has no word, and nor has a kind whose cell is missing", () => {
  expect(
    verdictOf(gvr("", "configmaps"), read(printed(["Data", "3"]))),
  ).toBeUndefined();
  expect(verdictOf(gvr("", "pods"), read(printed()))).toBeUndefined();
  expect(
    verdictOf(gvr("", "pods"), read(printed(["Status", ""]))),
  ).toBeUndefined();
});
