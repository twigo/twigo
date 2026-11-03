import { expect, test } from "vitest";
import type { Row } from "@twigo/protocol";
import { objectOf, type Selected } from "./selection";

function selected(id: string, namespaced: boolean): Selected {
  const row: Row = { id, created: null, generated: null, cells: [] };
  return {
    gvr: { group: "", version: "v1", resource: "pods" },
    kind: "Pod",
    namespaced,
    columns: [],
    row,
  };
}

test("a row's object reads from the right, whatever the context's name holds", () => {
  const eks = "arn:aws:eks:eu-west-1:123456789012:cluster/prod";
  expect(objectOf(selected(`${eks}/payments/api-0`, true))).toEqual({
    namespace: "payments",
    name: "api-0",
  });
  expect(objectOf(selected(`${eks}/node-1`, false))).toEqual({
    name: "node-1",
  });
  expect(objectOf(selected("kind-dev/payments/api-0", true))).toEqual({
    namespace: "payments",
    name: "api-0",
  });
});
