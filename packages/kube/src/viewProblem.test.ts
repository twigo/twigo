import { expect, test } from "vitest";
import type { ViewState } from "@twigo/protocol";
import { partsLine } from "./list/statusEntries";
import { viewProblem } from "./viewProblem";

test("a refusal is worded once: the empty state and the parts' tooltip say the same sentence, as Rust does", () => {
  const refused: ViewState[] = [
    { state: "forbidden", verb: "watch", resource: "pods" },
    { state: "unauthorized" },
  ];
  for (const state of refused) {
    const line = partsLine({
      count: 2,
      unready: [
        { part: { kind: "namespace", name: "team-b" }, state, shown: false },
      ],
      omitted: 0,
    });
    expect(line?.tooltip).toContain(
      `team-b: ${viewProblem(state, "pods")?.body}`,
    );
  }
  expect(viewProblem(refused[0] ?? { state: "ready" }, "pods")?.body).toBe(
    "You may not watch pods.",
  );
});
