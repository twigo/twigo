import { expect, test } from "vitest";
import { moveOf, pageOf, wheelDeltas } from "./input";

const chord = (
  key: string,
  { shift = false, ctrl = false, alt = false, meta = false } = {},
) => ({ key, shiftKey: shift, ctrlKey: ctrl, altKey: alt, metaKey: meta });

test.each([
  ["PageDown", "down", chord("PageDown")],
  ["PageUp", "up", chord("PageUp")],
  ["Space", "down", chord(" ")],
  ["⇧Space", "up", chord(" ", { shift: true })],
  ["⌥↓", "down", chord("ArrowDown", { alt: true })],
  ["⌥↑", "up", chord("ArrowUp", { alt: true })],
  ["⌃↓", "down", chord("ArrowDown", { ctrl: true })],
  ["⌃↑", "up", chord("ArrowUp", { ctrl: true })],
  ["⌃⌥↓", "down", chord("ArrowDown", { ctrl: true, alt: true })],
  ["⌃⌥↑", "up", chord("ArrowUp", { ctrl: true, alt: true })],
  ["⌘↑", "first", chord("ArrowUp", { meta: true })],
  ["⌘↓", "last", chord("ArrowDown", { meta: true })],
  ["⌃Home", "first", chord("Home", { ctrl: true })],
  ["⌃End", "last", chord("End", { ctrl: true })],
])("%s moves the list itself, on every platform: %s", (_, move, event) => {
  expect(moveOf(event)).toBe(move);
});

test.each([
  ["↓, which the list commands send", chord("ArrowDown")],
  ["End, which the list commands send", chord("End")],
  ["⌘C", chord("c", { meta: true })],
  ["⇧PageDown", chord("PageDown", { shift: true })],
  [
    "⌃⇧↓, on which no engine scrolls",
    chord("ArrowDown", { ctrl: true, shift: true }),
  ],
  ["⌃⇧↑", chord("ArrowUp", { ctrl: true, shift: true })],
  ["⌃⇧⌥↓", chord("ArrowDown", { ctrl: true, shift: true, alt: true })],
  ["⌃⌘↓", chord("ArrowDown", { ctrl: true, meta: true })],
  ["⌃Space", chord(" ", { ctrl: true })],
])("%s is not one of the list's own keys", (_, event) => {
  expect(moveOf(event)).toBeUndefined();
});

test.each([
  [600, 600 - 2 * 19],
  [400, 400 - 2 * 19],
  [90, 78],
  [50, 43],
  [30, 26],
  [1, 1],
])(
  "a page of a list %i px long is %i px: two rows short of it, in a short list seven eighths, and at least a pixel",
  (length, page) => {
    expect(pageOf(length)).toBe(page);
  },
);

const wheel = (init: Partial<WheelEventInit>) => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: WheelEvent.DOM_DELTA_PIXEL,
  ctrlKey: false,
  shiftKey: false,
  ...init,
});

const PAGE = 600 - 2 * 19;

test.each([
  [
    "of pixels scrolls by them",
    wheel({ deltaY: 40 }),
    false,
    { dx: 0, dy: 40 },
  ],
  [
    "of lines scrolls a row each",
    wheel({ deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE }),
    false,
    { dx: 0, dy: 3 * 19 },
  ],
  [
    "of pages scrolls a page of the list's height each",
    wheel({ deltaY: -2, deltaMode: WheelEvent.DOM_DELTA_PAGE }),
    false,
    { dx: 0, dy: -2 * PAGE },
  ],
  [
    "of lines sideways scrolls a row each",
    wheel({ deltaX: 2, deltaMode: WheelEvent.DOM_DELTA_LINE }),
    false,
    { dx: 2 * 19, dy: 0 },
  ],
  [
    "of pages sideways scrolls a page of the list's width each",
    wheel({ deltaX: 1, deltaMode: WheelEvent.DOM_DELTA_PAGE }),
    false,
    { dx: pageOf(700), dy: 0 },
  ],
  [
    "with ⇧ and a mouse's deltaX scrolls by it",
    wheel({ deltaX: 120, shiftKey: true }),
    false,
    { dx: 120, dy: 0 },
  ],
  [
    "with ⇧ and no deltaX off macOS scrolls sideways",
    wheel({ deltaY: 40, shiftKey: true }),
    false,
    { dx: 40, dy: 0 },
  ],
  [
    "with ⌃ off macOS is the engine's",
    wheel({ deltaY: -40, ctrlKey: true }),
    false,
    undefined,
  ],
  [
    "with ⇧ and no deltaX on macOS scrolls along its own axis",
    wheel({ deltaY: -40, shiftKey: true }),
    true,
    { dx: 0, dy: -40 },
  ],
  [
    "with ⌃ on macOS scrolls along its own axis",
    wheel({ deltaY: -40, ctrlKey: true }),
    true,
    { dx: 0, dy: -40 },
  ],
])("a wheel %s", (_, event, mac, deltas) => {
  expect(wheelDeltas(event, mac, 700, 600)).toEqual(deltas);
});
