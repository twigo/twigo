import { expect, test } from "vitest";
import type { Cell, Column, Resource } from "@twigo/protocol";
import { replicasOf } from "./resourceActions";
import { rowState } from "./rowState";
import type { Selected } from "./selection";

function resource(group: string, kind: string): Resource {
  return {
    gvr: { group, version: "v1", resource: `${kind.toLowerCase()}s` },
    kind,
    singular: kind.toLowerCase(),
    shortNames: [],
    namespaced: kind !== "Node",
    subresources: [],
  };
}

function selected(columns: string[], cells: Cell[]): Selected {
  return {
    gvr: { group: "", version: "v1", resource: "x" },
    kind: "X",
    namespaced: true,
    columns: columns.map((name): Column => ({
      name,
      kind: "string",
      priority: 0,
    })),
    row: { id: "qa/a/x", created: null, generated: null, cells },
  };
}

test("a row says whether its node is cordoned and its job suspended", () => {
  const node = resource("", "Node");
  expect(
    rowState(
      node,
      selected(["Name", "Status"], ["n", "Ready,SchedulingDisabled"]),
    ),
  ).toEqual({ "resource.cordoned": true });
  expect(rowState(node, selected(["Name", "Status"], ["n", "Ready"]))).toEqual({
    "resource.cordoned": false,
  });
  expect(
    rowState(
      resource("batch", "Job"),
      selected(["Name", "Status"], ["j", "Suspended"]),
    ),
  ).toEqual({ "resource.suspended": true });
  expect(
    rowState(
      resource("batch", "CronJob"),
      selected(["Name", "Suspend"], ["c", "False"]),
    ),
  ).toEqual({ "resource.suspended": false });
  expect(rowState(resource("batch", "CronJob"), undefined)).toEqual({
    "resource.suspended": false,
  });
  expect(
    rowState(resource("apps", "Deployment"), selected(["Name"], ["d"])),
  ).toEqual({});
});

test("a row says the replicas its object wants", () => {
  expect(replicasOf(selected(["Name", "Ready"], ["web", "2/5"]))).toBe(5);
  expect(replicasOf(selected(["Name", "Desired", "Ready"], ["rs", 3, 1]))).toBe(
    3,
  );
  expect(replicasOf(selected(["Name", "Status"], ["x", "Running"]))).toBe(
    undefined,
  );
});
