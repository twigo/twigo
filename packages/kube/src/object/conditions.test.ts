import { expect, test } from "vitest";
import type { Condition } from "@twigo/protocol";
import { unexplained } from "./conditions";

function condition(type: string, rest: Partial<Condition> = {}): Condition {
  return {
    type,
    status: "False",
    tone: "danger",
    reason: "ContainersNotReady",
    message: "containers with unready status: [api]",
    lastTransition: null,
    lastHeartbeat: null,
    explained: false,
    ...rest,
  };
}

test("conditions that are wrong with the same reason and message are one line, in the order they came", () => {
  expect(
    unexplained([
      condition("Ready"),
      condition("PodScheduled", { reason: "Unschedulable", message: null }),
      condition("ContainersReady"),
    ]),
  ).toEqual([
    {
      types: ["Ready", "ContainersReady"],
      reason: "ContainersNotReady",
      message: "containers with unready status: [api]",
    },
    { types: ["PodScheduled"], reason: "Unschedulable", message: null },
  ]);
});

test("a condition that is right, explained, or has nothing to say draws no line", () => {
  expect(
    unexplained([
      condition("Ready", { tone: "success", status: "True" }),
      condition("ContainersReady", { explained: true }),
      condition("Initialized", { reason: null, message: null }),
    ]),
  ).toEqual([]);
});

test("a warning is wrong too", () => {
  expect(
    unexplained([condition("DisruptionTarget", { tone: "warning" })]),
  ).toHaveLength(1);
});
