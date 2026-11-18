import { expect, test } from "vitest";
import type { Place } from "./pageStates";
import { keepPlace, placeOf } from "./place";

function page(heights: Record<string, number>) {
  const scroller = document.createElement("div");
  const content = document.createElement("div");
  scroller.append(content);
  const sections = Object.keys(heights).map((id) => {
    const section = document.createElement("section");
    section.dataset.section = id;
    content.append(section);
    return section;
  });
  let scrollTop = 0;
  const limit = { end: 10_000 };
  Object.defineProperty(scroller, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.min(limit.end, Math.max(0, value));
    },
  });
  Object.defineProperty(scroller, "clientHeight", { get: () => 600 });
  Object.defineProperty(scroller, "scrollHeight", {
    get: () => limit.end + 600,
  });
  scroller.getBoundingClientRect = () => new DOMRect(0, 100, 400, 600);
  let at = 16;
  const above = { grown: 0 };
  for (const [index, height] of Object.values(heights).entries()) {
    const start = at;
    section(
      sections[index],
      () => start + above.grown - scrollTop + 100,
      height,
    );
    at += height + 24;
  }
  return { scroller, sections, above, limit };
}

function section(
  element: HTMLElement | undefined,
  top: () => number,
  height: number,
) {
  if (!element) throw new Error("no section");
  element.getBoundingClientRect = () => new DOMRect(0, top(), 400, height);
}

test("the place is the section at the top of the viewport and how far into it, none at the top of the page", () => {
  const { scroller } = page({ a: 100, b: 300, c: 200 });
  expect(placeOf(scroller)).toBeUndefined();
  scroller.scrollTop = 200;
  expect(placeOf(scroller)).toEqual({ section: "b", offset: 60 });
  scroller.scrollTop = 5;
  expect(placeOf(scroller)).toBeUndefined();
});

test("another page of the same sections opens at the same offset into the same section", () => {
  const before = page({ a: 100, b: 300, c: 200 });
  before.scroller.scrollTop = 200;
  const place = placeOf(before.scroller);
  if (!place) throw new Error("no place");
  const after = page({ a: 150, b: 250, c: 500 });
  const stop = keepPlace(after.scroller, place, () => undefined);
  expect(placeOf(after.scroller)).toEqual({ section: "b", offset: 60 });
  stop();
});

test("a page without that section stays at its top", () => {
  const { scroller } = page({ a: 100, c: 200 });
  const stop = keepPlace(
    scroller,
    { section: "b", offset: 60 },
    () => undefined,
  );
  expect(scroller.scrollTop).toBe(0);
  stop();
});

test("what grows above the place is followed until the person scrolls", () => {
  const observers = new Set<() => void>();
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(report: () => void) {
      observers.add(report);
      this.#report = report;
    }
    readonly #report: () => void;
    observe() {
      return undefined;
    }
    disconnect() {
      observers.delete(this.#report);
    }
  } as unknown as typeof ResizeObserver;
  try {
    const { scroller, above } = page({ a: 100, b: 300, c: 200 });
    const stop = keepPlace(
      scroller,
      { section: "b", offset: 60 },
      () => undefined,
    );
    expect(placeOf(scroller)?.section).toBe("b");
    above.grown = 80;
    for (const report of observers) report();
    expect(placeOf(scroller)).toEqual({ section: "b", offset: 60 });
    scroller.scrollTop = 20;
    scroller.dispatchEvent(new Event("scroll"));
    above.grown = 160;
    for (const report of observers) report();
    expect(scroller.scrollTop).toBe(20);
    stop();
  } finally {
    globalThis.ResizeObserver = original;
  }
});

test("an offset deeper than the section is long opens at the end of the section", () => {
  const { scroller } = page({ a: 100, b: 100, c: 200 });
  const stop = keepPlace(
    scroller,
    { section: "b", offset: 400 },
    () => undefined,
  );
  expect(scroller.scrollTop).toBe(140 + 100);
  expect(placeOf(scroller)).toEqual({ section: "b", offset: 100 });
  stop();
});

test("only the scrolls the person makes are recorded, not the restore's own, a clamp, or one while the place is held", () => {
  const { scroller, limit } = page({ a: 100, b: 300, c: 200 });
  const recorded: (Place | undefined)[] = [];
  const stop = keepPlace(scroller, { section: "b", offset: 60 }, (place) => {
    recorded.push(place);
  });
  scroller.dispatchEvent(new Event("scroll"));
  expect(recorded).toEqual([]);

  scroller.scrollTop = 250;
  scroller.dispatchEvent(new Event("scroll"));
  expect(recorded).toEqual([{ section: "b", offset: 110 }]);

  limit.end = 100;
  scroller.scrollTop = 100;
  scroller.dispatchEvent(new Event("scroll"));
  expect(recorded).toHaveLength(1);

  scroller.scrollTop = 80;
  scroller.dispatchEvent(new Event("scroll"));
  expect(recorded).toHaveLength(2);
  stop();
});

test("a page without a place records the first scroll the person makes", () => {
  const { scroller } = page({ a: 100, b: 300, c: 200 });
  const recorded: (Place | undefined)[] = [];
  const stop = keepPlace(scroller, undefined, (place) => {
    recorded.push(place);
  });
  scroller.scrollTop = 200;
  scroller.dispatchEvent(new Event("scroll"));
  scroller.scrollTop = 0;
  scroller.dispatchEvent(new Event("scroll"));
  expect(recorded).toEqual([{ section: "b", offset: 60 }, undefined]);
  stop();
});

test("a slow scroll, a pixel a frame, releases the hold and is recorded", () => {
  const observers = new Set<() => void>();
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(report: () => void) {
      observers.add(report);
      this.#report = report;
    }
    readonly #report: () => void;
    observe() {
      return undefined;
    }
    disconnect() {
      observers.delete(this.#report);
    }
  } as unknown as typeof ResizeObserver;
  try {
    const { scroller, above } = page({ a: 100, b: 300, c: 200 });
    const recorded: (Place | undefined)[] = [];
    const stop = keepPlace(scroller, { section: "b", offset: 60 }, (place) => {
      recorded.push(place);
    });
    const held = scroller.scrollTop;
    for (let frame = 0; frame < 150; frame++) {
      scroller.scrollTop += 1;
      scroller.dispatchEvent(new Event("scroll"));
    }
    expect(scroller.scrollTop).toBe(held + 150);
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded[recorded.length - 1]).toEqual(placeOf(scroller));

    above.grown = 80;
    for (const report of observers) report();
    expect(scroller.scrollTop).toBe(held + 150);
    stop();
  } finally {
    globalThis.ResizeObserver = original;
  }
});
