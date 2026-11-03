import { expect, test } from "vitest";
import { fitWidth } from "./fit";

function grid(title: number, cells: readonly number[]): HTMLElement {
  const element = document.createElement("div");
  const header = document.createElement("span");
  header.dataset.fitHeader = "Name";
  Object.defineProperty(header, "scrollWidth", { value: title });
  element.append(header);
  for (const width of cells) {
    const cell = document.createElement("span");
    cell.dataset.fit = "Name";
    cell.getBoundingClientRect = () => new DOMRect(0, 0, width, 18);
    element.append(cell);
  }
  return element;
}

test("a fit gives the header its title, padding, sort arrow and right border, and a cell its content and padding", () => {
  expect(fitWidth(grid(100, [60]), "Name")).toBe(133);
  expect(fitWidth(grid(40, [150.2]), "Name")).toBe(167);
  expect(fitWidth(grid(4, [10]), "Name")).toBe(48);
});
