import { expect, test } from "vitest";
import { OverviewStates } from "./overviewStates";

const POD = "/pods";

test("a section opens as its fold says until the person chooses", () => {
  const states = new OverviewStates();
  expect(states.section(POD, "a", "core.containers", "open")).toBe(true);
  expect(states.section(POD, "a", "core.metadata", "folded")).toBe(false);
});

test("what the person chose is kept for the kind, either way", () => {
  const states = new OverviewStates();
  states.setSections(
    POD,
    "a",
    [{ id: "core.containers", fold: "open" }],
    false,
  );
  states.setSections(POD, "a", [{ id: "core.metadata", fold: "folded" }], true);
  expect(states.section(POD, "b", "core.containers", "open")).toBe(false);
  expect(states.section(POD, "b", "core.metadata", "folded")).toBe(true);
  expect(
    states.section("apps/deployments", "b", "core.metadata", "folded"),
  ).toBe(false);
});

test("what the person chose is open or folded, so an object whose section starts the other way reads it as left", () => {
  const folded = new OverviewStates();
  folded.setSections(POD, "a", [{ id: "core.events", fold: "open" }], false);
  expect(folded.section(POD, "b", "core.events", "folded")).toBe(false);
  expect(folded.section(POD, "b", "core.events", "open")).toBe(false);
  const opened = new OverviewStates();
  opened.setSections(POD, "a", [{ id: "core.events", fold: "folded" }], true);
  expect(opened.section(POD, "b", "core.events", "open")).toBe(true);
  expect(opened.section(POD, "b", "core.events", "folded")).toBe(true);
});

test("a finding opens over a section the person folded", () => {
  const states = new OverviewStates();
  states.setSections(
    POD,
    "a",
    [{ id: "core.conditions", fold: "open" }],
    false,
  );
  expect(states.section(POD, "a", "core.conditions", "open")).toBe(false);
  expect(states.section(POD, "a", "core.conditions", "finding")).toBe(true);
  expect(states.section(POD, "a", "core.conditions", "open")).toBe(false);
});

test("a finding the person folds stays folded for its object only, and leaves the kind's choice alone", () => {
  const states = new OverviewStates();
  const finding = { id: "core.conditions", fold: "finding" as const };
  states.setSection(POD, "a", finding, false);
  expect(states.section(POD, "a", "core.conditions", "finding")).toBe(false);
  expect(states.section(POD, "b", "core.conditions", "finding")).toBe(true);
  expect(states.section(POD, "a", "core.conditions", "open")).toBe(true);
  states.setSection(POD, "a", finding, true);
  expect(states.section(POD, "a", "core.conditions", "finding")).toBe(true);
});

test("opening or folding every section sets each and tells once", () => {
  const states = new OverviewStates();
  let told = 0;
  states.changes.subscribe(() => {
    told++;
  });
  const sections = [
    { id: "core.containers", fold: "open" as const },
    { id: "core.metadata", fold: "folded" as const },
    { id: "core.conditions", fold: "finding" as const },
  ];
  states.setSections(POD, "a", sections, false);
  expect(sections.map((s) => states.section(POD, "a", s.id, s.fold))).toEqual([
    false,
    false,
    false,
  ]);
  states.setSections(POD, "a", sections, true);
  expect(sections.map((s) => states.section(POD, "a", s.id, s.fold))).toEqual([
    true,
    true,
    true,
  ]);
  states.setSections(POD, "a", sections, true);
  expect(told).toBe(2);
});

test("opening or folding every section keeps the choice for the sections that already were so, for an object whose own fold differs", () => {
  const states = new OverviewStates();
  const sections = [
    { id: "core.events", fold: "open" as const },
    { id: "core.metadata", fold: "folded" as const },
  ];
  states.setSections(POD, "a", sections, true);
  expect(states.section(POD, "b", "core.events", "folded")).toBe(true);
  expect(states.section(POD, "b", "core.metadata", "open")).toBe(true);
  states.setSections(POD, "a", sections, false);
  expect(states.section(POD, "b", "core.events", "open")).toBe(false);
  expect(states.section(POD, "b", "core.metadata", "open")).toBe(false);
});

test("opening or folding every section keeps the choice for a finding too, for an object where that section is an ordinary one", () => {
  const states = new OverviewStates();
  const crashing = [
    { id: "core.pod", fold: "folded" as const },
    { id: "core.events", fold: "finding" as const },
  ];
  states.setSections(POD, "dev/crashing", crashing, true);
  expect(states.section(POD, "dev/healthy", "core.pod", "folded")).toBe(true);
  expect(states.section(POD, "dev/healthy", "core.events", "folded")).toBe(
    true,
  );
  states.setSections(POD, "dev/crashing", crashing, false);
  expect(states.section(POD, "dev/crashing", "core.events", "finding")).toBe(
    false,
  );
  expect(states.section(POD, "dev/healthy", "core.events", "open")).toBe(false);
});
