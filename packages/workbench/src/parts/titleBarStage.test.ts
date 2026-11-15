import { expect, test } from "vitest";
import { titleBarStage, type TitleBarTexts } from "./titleBarStage";

const PRODUCTION: TitleBarTexts = {
  name: "prod-eu",
  scope: "All namespaces",
  chip: "Production · read-only",
};

const folds = (width: number, texts: TitleBarTexts = PRODUCTION) => {
  const { searchFolded, chipFolded } = titleBarStage(width, texts);
  return [searchFolded, chipFolded];
};

test("the search folds first, then the chip, as the bar narrows", () => {
  const seen = [1600, 1280, 1100, 900, 700].map((width) => folds(width));
  expect(seen).toEqual([
    [false, false],
    [false, false],
    [true, false],
    [true, true],
    [true, true],
  ]);
  for (let width = 1600; width > 400; width -= 10) {
    const [search, chip] = folds(width);
    expect(chip && !search).toBe(false);
  }
});

test("at 1,100 px a short name and All namespaces keep their chip's words", () => {
  expect(folds(1100)).toEqual([true, false]);
});

test("a bar not yet measured shows everything", () => {
  expect(folds(0)).toEqual([false, false]);
});

test("a longer name or scope folds at a wider bar", () => {
  const at = (texts: TitleBarTexts) => {
    for (let width = 1800; width > 0; width--) {
      if (titleBarStage(width, texts).searchFolded) return width;
    }
    return 0;
  };
  const wide = at(PRODUCTION);
  expect(
    at({ ...PRODUCTION, scope: "payments, checkout, ledger" }),
  ).toBeGreaterThan(wide);
  expect(
    at({ ...PRODUCTION, name: "prod-eu + staging + dev" }),
  ).toBeGreaterThan(wide);
});

test("a space with no chip leaves the chip's room to the name and the scope", () => {
  const without = { ...PRODUCTION, chip: undefined };
  expect(folds(800, PRODUCTION)).toEqual([true, true]);
  expect(folds(800, without)).toEqual([true, false]);
});
