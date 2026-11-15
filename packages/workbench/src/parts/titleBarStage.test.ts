import { expect, test } from "vitest";
import {
  breadcrumbRoom,
  SEARCH_FIELD,
  titleBarStage,
  TRAFFIC_LIGHTS,
  type TitleBarWidths,
} from "./titleBarStage";

const WIDTHS: TitleBarWidths = { crumbs: 400, searchIcon: 60 };

const STAGES: Record<string, string> = {
  "false false true": "unfolded",
  "true false true": "search",
  "true false false": "search at the end",
  "true true false": "search at the end, chip",
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

test("as the bar narrows the search folds, then leaves the middle, then the chip folds, and none comes back", () => {
  expect(stagesAsItNarrows()).toEqual([
    "unfolded",
    "search",
    "search at the end",
    "search at the end, chip",
  ]);
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

test("a part stays as it is only where the layout fits, whichever way the widths were rounded", () => {
  const icons = [59.5, 60.02, 60.49];
  const wrong: string[] = [];
  for (const crumbs of [400.13, 400.5, 400.87]) {
    for (const icon of icons) {
      for (let width = 700; width < 1500; width += 0.0625) {
        const stage = titleBarStage(Math.round(width), {
          crumbs: Math.round(crumbs),
          searchIcon: Math.round(icon),
        });
        const room = stage.searchFolded
          ? breadcrumbRoom(width, icon, stage.centred)
          : breadcrumbRoom(width, SEARCH_FIELD, true);
        if (!stage.chipFolded && TRAFFIC_LIGHTS + crumbs > room) {
          wrong.push(`${String(width)} ${String(crumbs)} ${String(icon)}`);
        }
      }
    }
  }
  expect(wrong).toEqual([]);
});
