import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { INITIAL_OBJECT, type Overview } from "@twigo/protocol";
import { ObjectContent } from "./ObjectContent";
import { OverviewStates } from "./overviewStates";
import { PageStates } from "./pageStates";

const URI = "k8s-list://dev/v1/pods";
const STARTS: Record<string, number> = { a: 16, b: 140, c: 464 };

const scrolled = new WeakMap<Element, number>();
const limit = { end: 10_000 };

beforeEach(() => {
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (
    this: Element,
  ) {
    return scrolled.get(this) ?? 0;
  });
  vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (
    this: Element,
    value: number,
  ) {
    scrolled.set(this, Math.min(limit.end, Math.max(0, value)));
  });
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(
    () => limit.end + 600,
  );
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(
    () => 600,
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      if (this.getAttribute("role") === "tabpanel")
        return new DOMRect(0, 100, 400, 600);
      const panel = this.closest('[role="tabpanel"]');
      const id = this instanceof HTMLElement ? this.dataset.section : undefined;
      if (id === undefined || !panel) return new DOMRect();
      return new DOMRect(
        0,
        100 + (STARTS[id] ?? 0) - (scrolled.get(panel) ?? 0),
        400,
        100,
      );
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  limit.end = 10_000;
});

function overview(ids: string[]): Overview {
  return {
    header: {
      owner: null,
      node: null,
      created: null,
      generated: null,
      printed: [],
      sentence: [],
      vitals: [],
    },
    sections: ids.map((id) => ({
      id,
      title: id.toUpperCase(),
      summary: [],
      tone: null,
      fold: "open",
      blocks: [],
    })),
  };
}

function shown(pages: PageStates, object: string, ids = ["a", "b", "c"]) {
  return (
    <ObjectContent
      tab="overview"
      space="dev"
      states={new OverviewStates()}
      kind="/pods"
      pages={pages}
      uri={URI}
      object={object}
      snapshot={{
        ...INITIAL_OBJECT,
        status: { state: "ready" },
        exists: true,
        overview: overview(ids),
      }}
      values={undefined}
      onOpen={() => undefined}
      onEvents={() => undefined}
    />
  );
}

const panel = () => screen.getByRole("tabpanel", { name: "Overview" });

test("another object of the kind opens at the same offset into the section that was at the top, and the same object drawn again stays where it is", () => {
  const pages = new PageStates();
  const first = render(shown(pages, "ns/web-1"));
  scrolled.set(panel(), 200);
  fireEvent.scroll(panel());
  expect(pages.place(URI)).toEqual({ section: "b", offset: 60 });
  first.unmount();

  const second = render(shown(pages, "ns/web-2"));
  expect(scrolled.get(panel())).toBe(200);
  scrolled.set(panel(), 120);
  second.rerender(shown(pages, "ns/web-2"));
  expect(scrolled.get(panel())).toBe(120);
  second.unmount();

  render(shown(pages, "ns/web-3", ["a", "c"]));
  expect(scrolled.get(panel()) ?? 0).toBe(0);
});

test("a pod too short to reach the place, or a page shrunk by a filter to one screen, does not move the place of the pods after it", () => {
  const pages = new PageStates();
  const first = render(shown(pages, "ns/web-1"));
  scrolled.set(panel(), 494);
  fireEvent.scroll(panel());
  const left = pages.place(URI);
  expect(left).toEqual({ section: "c", offset: 30 });
  first.unmount();

  limit.end = 300;
  const short = render(shown(pages, "ns/web-2"));
  expect(scrolled.get(panel())).toBe(300);
  fireEvent.scroll(panel());
  expect(pages.place(URI)).toEqual(left);
  short.unmount();

  limit.end = 10_000;
  const third = render(shown(pages, "ns/web-3"));
  expect(scrolled.get(panel())).toBe(494);
  scrolled.set(panel(), 0);
  limit.end = 0;
  fireEvent.scroll(panel());
  expect(pages.place(URI)).toEqual(left);
  third.unmount();

  limit.end = 10_000;
  render(shown(pages, "ns/web-4"));
  expect(scrolled.get(panel())).toBe(494);
});
