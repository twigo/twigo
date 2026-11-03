import { afterEach, beforeEach, expect, test } from "vitest";
import { fitWidth } from "./fit";

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      const free = this.style.width === "max-content";
      const width = Number(free ? this.dataset.natural : this.dataset.cut);
      return new DOMRect(0, 0, width, 18);
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "getBoundingClientRect");
});

function grid(
  title: number,
  cells: readonly (
    number | { natural: number; cut?: number; margin?: string }
  )[],
): HTMLElement {
  const element = document.createElement("div");
  const header = document.createElement("span");
  header.dataset.fitHeader = "Name";
  Object.defineProperty(header, "scrollWidth", { value: title });
  element.append(header);
  for (const width of cells) {
    const {
      natural,
      cut = natural,
      margin = "",
    } = typeof width === "number" ? { natural: width } : width;
    const cell = document.createElement("span");
    cell.dataset.fit = "Name";
    cell.dataset.natural = String(natural);
    cell.dataset.cut = String(cut);
    cell.style.margin = margin;
    element.append(cell);
  }
  return element;
}

test("a fit gives the header its title, padding, sort arrow and right border, and a cell its content and padding", () => {
  expect(fitWidth(grid(100, [60]), "Name")).toBe(133);
  expect(fitWidth(grid(40, [150.2]), "Name")).toBe(167);
  expect(fitWidth(grid(4, [10]), "Name")).toBe(48);
});

test("a fit counts a cut cell whole, and without its content's negative margins", () => {
  expect(fitWidth(grid(40, [{ natural: 180, cut: 100 }]), "Name")).toBe(196);
  expect(
    fitWidth(grid(40, [{ natural: 68, margin: "0px -4px" }]), "Name"),
  ).toBe(76);
});

test("a fit leaves the grid as it found it", () => {
  const element = grid(40, [60, 70]);
  fitWidth(element, "Name");
  expect(element.children).toHaveLength(3);
});
