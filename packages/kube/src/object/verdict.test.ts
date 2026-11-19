import { expect, test } from "vitest";
import type { Gvr, Overview, Printed, Section } from "@twigo/protocol";
import { NO_HEADER } from "../../test/object";
import { foundTone, verdictOf } from "./verdict";

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

const section = (id: string, rest: Partial<Section>): Section => ({
  id,
  title: id,
  summary: [],
  tone: null,
  fold: "open",
  blocks: [],
  ...rest,
});

const PAST_ITS_DEADLINE: Overview = {
  header: {
    ...NO_HEADER,
    printed: printed(["Ready", "4/4"]),
    sentence: [{ type: "text", text: "The rollout is stuck" }],
  },
  sections: [
    section("core.diagnostics", {
      tone: "danger",
      blocks: [
        {
          type: "diagnostics",
          findings: [
            {
              logs: null,
              tone: "danger",
              title: "The rollout is stuck",
              detail: [],
              message: "ReplicaSet has timed out progressing.",
            },
          ],
        },
      ],
    }),
    section("core.conditions", {
      blocks: [
        {
          type: "conditions",
          conditions: [
            {
              type: "Progressing",
              status: "False",
              tone: "danger",
              reason: "ProgressDeadlineExceeded",
              message: "ReplicaSet has timed out progressing.",
              lastTransition: "2026-11-18T10:00:00Z",
              lastHeartbeat: null,
              explained: true,
            },
          ],
        },
      ],
    }),
  ],
};

test("a Deployment that is 4/4 and past its progress deadline takes the tone of the core's finding, which the list's word cannot say", () => {
  const deployment = gvr("apps", "deployments");
  const found = foundTone(PAST_ITS_DEADLINE);
  expect(found).toBe("error");
  const cells = read(PAST_ITS_DEADLINE.header.printed);
  expect(verdictOf(deployment, cells)).toMatchObject({
    word: "4/4",
    tone: undefined,
  });
  expect(verdictOf(deployment, cells, found)).toMatchObject({
    word: "4/4",
    tone: "error",
  });
});

test("the list's own tone stays over the core's, and an Overview without findings tells none", () => {
  const deployment = gvr("apps", "deployments");
  expect(
    verdictOf(deployment, read(printed(["Ready", "3/4"])), "error")?.tone,
  ).toBe("warn");
  expect(foundTone(undefined)).toBeUndefined();
  expect(
    foundTone({ ...PAST_ITS_DEADLINE, sections: [section("core.pod", {})] }),
  ).toBeUndefined();
});
