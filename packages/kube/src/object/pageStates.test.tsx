import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { PageStates, useFiltered } from "./pageStates";

afterEach(cleanup);

const URI = "k8s://editor";

function page(): HTMLElement {
  const element = document.createElement("div");
  element.tabIndex = -1;
  document.body.append(element);
  return element;
}

test("a page asked to take the focus while it is not drawn does not take it when it is drawn later", () => {
  const pages = new PageStates();
  pages.focusPage(URI);
  const element = page();
  pages.attach(URI, element);
  expect(document.activeElement).not.toBe(element);
});

test("an editor that has just come has its page take the focus once it is drawn, and only once", () => {
  const pages = new PageStates();
  pages.focusPageOnceDrawn(URI);
  const first = page();
  const detach = pages.attach(URI, first);
  expect(document.activeElement).toBe(first);
  detach();
  const second = page();
  pages.attach(URI, second);
  expect(document.activeElement).toBe(first);
});

test("a page that is drawn takes the focus at once", () => {
  const pages = new PageStates();
  const element = page();
  pages.attach(URI, element);
  pages.focusPage(URI);
  expect(document.activeElement).toBe(element);
});

test("whether the filter holds text draws again only when that changes, not with each key typed", () => {
  const pages = new PageStates();
  let drawn = 0;
  let filtered = false;
  function Probe() {
    drawn++;
    filtered = useFiltered(pages, URI);
    return null;
  }
  render(<Probe />);
  const first = drawn;
  for (const text of ["a", "ab", "abc", "abcd"]) {
    act(() => {
      pages.setText(URI, text);
    });
  }
  expect(filtered).toBe(true);
  expect(drawn - first).toBe(1);
  act(() => {
    pages.setText(URI, "");
  });
  expect(filtered).toBe(false);
  expect(drawn - first).toBe(2);
});
