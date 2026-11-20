import { expect, test } from "vitest";
import type { Parts } from "@twigo/protocol";
import { leavesOut } from "./listStatus";

test("a list leaves out the namespaces whose waiting part shows no rows", () => {
  const waiting = (shown: boolean): Parts => ({
    count: 3,
    unready: [
      {
        part: { kind: "namespace", name: "auth" },
        state: { state: "queued" },
        shown,
      },
    ],
  });
  expect(leavesOut(waiting(false))).toBe(true);
  expect(leavesOut(waiting(true))).toBe(false);
});
