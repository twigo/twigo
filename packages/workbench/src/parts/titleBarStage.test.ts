import { expect, test } from "vitest";
import { titleBarStage, type TitleBarWidths } from "./titleBarStage";

const WIDTHS: TitleBarWidths = {
  crumbs: 400,
  crumbsChipFolded: 300,
  searchIcon: 60,
};

const NAMES = ["unfolded", "search", "search and chip", "search at the end"];

const STAGES: Record<string, string> = {
  "false false true": "unfolded",
  "true false true": "search",
  "true true true": "search and chip",
  "true true false": "search at the end",
};

const stageName = (width: number, widths: TitleBarWidths = WIDTHS) => {
  const { searchFolded, chipFolded, centred } = titleBarStage(width, widths);
  return (
    STAGES[
      `${String(searchFolded)} ${String(chipFolded)} ${String(centred)}`
    ] ?? "a state that should not occur"
  );
};

const stagesAsItNarrows = (widths: TitleBarWidths = WIDTHS) => {
  const seen: string[] = [];
  for (let width = 1800; width > 300; width--) {
    const stage = stageName(width, widths);
    if (stage !== seen[seen.length - 1]) seen.push(stage);
  }
  return seen;
};

const firstFoldAt = (widths: TitleBarWidths) => {
  for (let width = 1800; width > 0; width--) {
    if (titleBarStage(width, widths).searchFolded) return width;
  }
  return 0;
};

test("as the bar narrows the search folds first, then the chip, then the search leaves the middle, and none comes back", () => {
  expect(stagesAsItNarrows()).toEqual(NAMES);
});

test("a longer breadcrumb folds at a wider bar", () => {
  const wide = firstFoldAt(WIDTHS);
  expect(wide).toBeGreaterThan(0);
  expect(firstFoldAt({ ...WIDTHS, crumbs: 500 })).toBeGreaterThan(wide);
});

test("a bar or a part not yet measured shows everything", () => {
  expect(stageName(0)).toBe("unfolded");
  expect(stageName(500, { ...WIDTHS, crumbs: 0 })).toBe("unfolded");
  expect(stageName(500, { ...WIDTHS, searchIcon: 0 })).toBe("unfolded");
});

test("a space with no chip goes from the search straight to the end", () => {
  const without = { ...WIDTHS, crumbsChipFolded: WIDTHS.crumbs };
  expect(stagesAsItNarrows(without)).toEqual([
    "unfolded",
    "search",
    "search at the end",
  ]);
});
