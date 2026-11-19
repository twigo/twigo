import { expect, test } from "vitest";
import type { Overview, Section } from "@twigo/protocol";
import { outlineOf } from "./outline";
import { OverviewStates } from "./overviewStates";

const section = (
  id: string,
  title: string,
  fold: Section["fold"],
  value = "",
): Section => ({
  id,
  title,
  summary: [],
  tone: null,
  fold,
  blocks: [
    {
      type: "fields",
      fields: [
        {
          label: "Field",
          value: { type: "text", text: value },
          default: false,
        },
      ],
    },
  ],
});

const PAGE: Overview = {
  header: {
    owner: null,
    node: null,
    created: null,
    generated: null,
    printed: [],
    sentence: [],
    vitals: [],
  },
  sections: [
    section("core.diagnostics", "Diagnostics", "open", "crash"),
    section("core.placement", "Placement", "finding", "worker-3"),
    section("core.conditions", "Conditions", "folded", "True"),
    section("core.metadata", "Metadata", "open", "api"),
  ],
};

const folds = (fullPage: boolean) =>
  Object.fromEntries(
    outlineOf(PAGE, false, fullPage).map(({ id, fold }) => [id, fold]),
  );

test("the full page opens every section but the Metadata, and a section that holds a finding stays one", () => {
  expect(folds(true)).toEqual({
    "core.diagnostics": "open",
    "core.placement": "finding",
    "core.conditions": "open",
    "core.metadata": "folded",
  });
  expect(folds(false)).toEqual({
    "core.diagnostics": "open",
    "core.placement": "finding",
    "core.conditions": "folded",
    "core.metadata": "open",
  });
});

test("a fold the person remembered for the kind never hides a finding on the full page", () => {
  const states = new OverviewStates();
  const [first, second] = ["core.diagnostics", "core.placement"].map((id) =>
    outlineOf(PAGE, false, true).find((entry) => entry.id === id),
  );
  if (!first || !second) throw new Error("the sections");
  states.setSection("/pods", "a/b", first, false);
  states.setSection("/pods", "x/y", { id: second.id, fold: "open" }, false);
  const open = (entry: typeof first, object: string) =>
    states.section("/pods", object, entry.id, entry.fold);
  expect(open(first, "a/b")).toBe(false);
  expect(open(second, "a/b")).toBe(true);
  expect(open(second, "x/y")).toBe(true);
});
