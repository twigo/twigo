import { afterEach, expect, test } from "vitest";
import { ListGrids } from "./grids";

const URI = "k8s-list://qa/v1/pods";

afterEach(() => {
  document.body.replaceChildren();
});

function element(tag = "div"): HTMLElement {
  const made = document.createElement(tag);
  made.tabIndex = 0;
  document.body.append(made);
  return made;
}

test("a mounted grid takes the focus at once", () => {
  const grids = new ListGrids();
  const grid = element();
  grids.add(URI, grid);
  grids.focus(URI);
  expect(document.activeElement).toBe(grid);
});

test("a list asked for the focus before its grid mounted gets it when the grid does", () => {
  const grids = new ListGrids();
  const group = element();
  group.focus();
  grids.focus(URI);
  const grid = element();
  grids.add(URI, grid);
  expect(document.activeElement).toBe(grid);
});

test("a grid that mounts after the focus moved on does not take it", () => {
  const grids = new ListGrids();
  element().focus();
  grids.focus(URI);
  const elsewhere = element("input");
  elsewhere.focus();
  const grid = element();
  grids.add(URI, grid);
  expect(document.activeElement).toBe(elsewhere);
});

test("a list that closed before its grid mounted takes no focus", () => {
  const grids = new ListGrids();
  element().focus();
  grids.focus(URI);
  grids.closed(URI);
  const held = document.activeElement;
  grids.add(URI, element());
  expect(document.activeElement).toBe(held);
});

test("the focus a grid took is not asked for again when it mounts anew", () => {
  const grids = new ListGrids();
  element().focus();
  grids.focus(URI);
  const first = element();
  const forget = grids.add(URI, first);
  forget();
  const elsewhere = element("input");
  elsewhere.focus();
  grids.add(URI, element());
  expect(document.activeElement).toBe(elsewhere);
});
