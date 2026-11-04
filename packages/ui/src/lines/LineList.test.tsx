import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { ScrollText } from "lucide-react";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { resize } from "../../test/resize";
import type { ListController } from "../lib/list";
import { LineList, type LineItem } from "./LineList";
import { StyledText } from "./StyledText";

let shown = 600;
const tops = new WeakMap<HTMLElement, number>();
const maxOf = (element: HTMLElement) =>
  Math.max(0, element.scrollHeight - element.clientHeight);

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      const top = Math.min(tops.get(this) ?? 0, maxOf(this));
      tops.set(this, top);
      return top;
    },
    set(this: HTMLElement, top: number) {
      tops.set(this, Math.min(Math.max(0, top), maxOf(this)));
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => shown,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      const sizer = this.firstElementChild;
      return sizer instanceof HTMLElement
        ? Number.parseFloat(sizer.style.height) || 0
        : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      if (options.top !== undefined) this.scrollTop = options.top;
    },
  });
});

afterAll(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  shown = 600;
});

const line = (key: number, text = `line ${String(key)}`): LineItem => ({
  kind: "line",
  key: String(key),
  tag: "h8lbx",
  time: "10:41:02.402",
  text,
  runs: [],
  marks: [],
});

const lines = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, index) => line(from + index));

type Props = Parameters<typeof LineList>[0];

function mount(props: Partial<Props> = {}) {
  const onWindow = vi.fn();
  const onFollowChange = vi.fn();
  const onPlace = vi.fn();
  let current: Props = {
    label: "Logs",
    total: 5,
    start: 0,
    items: lines(0, 5),
    follow: true,
    wrap: false,
    timestamps: true,
    fresh: 0,
    onWindow,
    onFollowChange,
    onPlace,
    ...props,
  };
  const view = render(<LineList {...current} />);
  return {
    log: screen.getByRole("log"),
    onWindow,
    onFollowChange,
    onPlace,
    update: (change: Partial<Props>) => {
      current = { ...current, ...change };
      view.rerender(<LineList {...current} />);
    },
  };
}

function scroll(log: HTMLElement, top: number) {
  act(() => {
    log.scrollTop = top;
    fireEvent.scroll(log);
  });
}

function wheel(log: HTMLElement, top: number) {
  act(() => {
    fireEvent.wheel(log, { deltaY: top - log.scrollTop });
    fireEvent.scroll(log);
  });
}

function spin(log: HTMLElement, init: WheelEventInit) {
  let left = true;
  act(() => {
    left = fireEvent.wheel(log, init);
  });
  return left;
}

function wide(log: HTMLElement) {
  let at = 0;
  Object.defineProperty(log, "clientWidth", { configurable: true, value: 700 });
  Object.defineProperty(log, "scrollWidth", {
    configurable: true,
    value: 2000,
  });
  Object.defineProperty(log, "scrollLeft", {
    configurable: true,
    get: () => at,
    set: (left: number) => {
      at = Math.min(Math.max(0, left), 2000 - 700);
    },
  });
}

const around = (key: string) => ({ around: key, before: 40, after: 40 });

const height = (row: HTMLElement) => {
  const key = /line (\d+)$/.exec(row.textContent)?.[1];
  return key !== undefined && Number(key) % 3 === 0 ? 38 : 19;
};

function wrapped() {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.index === undefined ? 0 : height(this);
    },
  );
}

const CENTRE = (19 - 600) / 2;

const startOf = (log: HTMLElement, key: string) => {
  const row = [...log.querySelectorAll<HTMLElement>("[data-index]")].find(
    (each) => each.textContent.endsWith(`line ${key}`),
  );
  return Number(/translateY\((.+)px\)/.exec(row?.style.transform ?? "")?.[1]);
};

function hide(log: HTMLElement) {
  act(() => {
    shown = 0;
    resize();
  });
  Object.defineProperty(log, "scrollTop", {
    configurable: true,
    get: () => 0,
    set: () => undefined,
  });
}

function show(log: HTMLElement) {
  Reflect.deleteProperty(log, "scrollTop");
  log.scrollTop = 0;
  act(() => {
    shown = 600;
    resize();
  });
}

test("following, it asks for the tail and keeps the end in view", () => {
  const { log, onWindow } = mount({
    total: 300,
    start: 260,
    items: lines(260, 300),
  });
  expect(onWindow).toHaveBeenLastCalledWith({ tail: 40 });
  expect(log.scrollTop).toBe(19 * 300 - 600);
});

test("paused, it asks for a range around what it shows, then holds its top line once it is loaded and says so", () => {
  const { onWindow, onPlace } = mount({ follow: false });
  expect(onWindow).toHaveBeenCalledWith({ start: 0, end: 44 });
  expect(onWindow).toHaveBeenLastCalledWith(around("0"));
  expect(onPlace).toHaveBeenLastCalledWith({ key: "0", offset: 0 });
});

test("paused, a scroll asks for the lines around the top line by its key", () => {
  const { log, onWindow, onFollowChange, onPlace } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  scroll(log, 19 * 120);
  expect(onWindow).toHaveBeenLastCalledWith(around("120"));
  expect(onPlace).toHaveBeenLastCalledWith({ key: "120", offset: 0 });
  expect(onFollowChange).not.toHaveBeenCalled();
});

test("paused, a scroll too small to show other rows still moves the place it keeps", () => {
  const { log, onPlace } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  scroll(log, 19 * 120);
  scroll(log, 19 * 120 + 3);
  expect(onPlace).toHaveBeenLastCalledWith({ key: "120", offset: 3 });
});

test("a wheel up pauses following at once, and the list scrolls up by it itself", () => {
  const { log, onFollowChange } = mount({ total: 300, items: lines(0, 300) });
  expect(spin(log, { deltaY: -40 })).toBe(false);
  expect(onFollowChange).toHaveBeenCalledWith(false);
  expect(log.scrollTop).toBe(19 * 300 - 600 - 40);
});

test("paused, the list scrolls down by a wheel itself, and one whose delta reaches the end follows again at once, one short of it not", () => {
  const { log, onFollowChange } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  expect(spin(log, { deltaY: 19 * 300 - 600 - 40 })).toBe(false);
  expect(log.scrollTop).toBe(19 * 300 - 600 - 40);
  expect(onFollowChange).not.toHaveBeenCalled();
  expect(spin(log, { deltaY: 40 })).toBe(false);
  expect(log.scrollTop).toBe(19 * 300 - 600);
  expect(onFollowChange).toHaveBeenLastCalledWith(true);
});

test("a wheel scrolls the list by its pixels, by a row a line and by a page a page", () => {
  const { log } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  scroll(log, 19 * 100);
  const tops = [
    { deltaY: 40 },
    { deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE },
    { deltaY: 1, deltaMode: WheelEvent.DOM_DELTA_PAGE },
    { deltaY: -2, deltaMode: WheelEvent.DOM_DELTA_PAGE },
  ].map((init) => [spin(log, init), log.scrollTop - 19 * 100]);
  expect(tops).toEqual([
    [false, 40],
    [false, 40 + 3 * 19],
    [false, 40 + 3 * 19 + PAGE],
    [false, 40 + 3 * 19 - PAGE],
  ]);
});

test("a wheel's deltas below a pixel add up, though the browser keeps whole pixels", () => {
  const { log } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  scroll(log, 19 * 100);
  let at = log.scrollTop;
  Object.defineProperty(log, "scrollTop", {
    configurable: true,
    get: () => at,
    set: (top: number) => {
      at = Math.trunc(top);
    },
  });
  for (let round = 0; round < 4; round++) spin(log, { deltaY: 0.5 });
  expect(log.scrollTop).toBe(19 * 100 + 2);
});

test("a wheel the list cannot scroll by, at its top or its end, is the browser's", () => {
  const top = mount({ follow: false, total: 300, items: lines(0, 300) });
  const left = [spin(top.log, { deltaY: -40 }), spin(top.log, { deltaY: 40 })];
  cleanup();
  const end = mount({ total: 300, items: lines(0, 300) });
  left.push(spin(end.log, { deltaY: 40 }), spin(end.log, { deltaY: -40 }));
  expect(left).toEqual([true, false, true, false]);
  expect(end.log.scrollTop).toBe(19 * 300 - 600 - 40);
});

test("without wrap, the list scrolls sideways by a wheel's deltaX itself, ⇧ with a mouse's included, and at its left edge the wheel is the browser's", () => {
  const { log } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  wide(log);
  const lefts = [
    { deltaX: 100 },
    { deltaX: 120, shiftKey: true },
    { deltaX: -300 },
    { deltaX: -10 },
    { deltaX: 50, deltaY: 40 },
  ].map((init) => [spin(log, init), log.scrollLeft]);
  expect(lefts).toEqual([
    [false, 100],
    [false, 220],
    [false, 0],
    [true, 0],
    [false, 50],
  ]);
  expect(log.scrollTop).toBe(40);
});

test("on macOS the list takes a wheel with ⌃, or with ⇧ and no deltaX, along its own axis, as WebKit there scrolls it", () => {
  const { log, onFollowChange } = mount({
    total: 300,
    items: lines(0, 300),
    mac: true,
  });
  wide(log);
  expect([
    spin(log, { deltaY: -40, ctrlKey: true }),
    spin(log, { deltaY: -40, shiftKey: true }),
  ]).toEqual([false, false]);
  expect([log.scrollTop, log.scrollLeft]).toEqual([19 * 300 - 600 - 80, 0]);
  expect(onFollowChange).toHaveBeenCalledWith(false);
});

test("elsewhere a wheel with ⌃ is the engine's, and one with ⇧ and no deltaX scrolls sideways", () => {
  const { log, onFollowChange } = mount({ total: 300, items: lines(0, 300) });
  wide(log);
  expect([
    spin(log, { deltaY: -40, ctrlKey: true }),
    spin(log, { deltaY: 40, shiftKey: true }),
  ]).toEqual([true, false]);
  expect([log.scrollTop, log.scrollLeft]).toEqual([19 * 300 - 600, 40]);
  expect(onFollowChange).not.toHaveBeenCalled();
});

test("a wheel's sideways deltas below a pixel add up too", () => {
  const { log } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  wide(log);
  let at = 0;
  Object.defineProperty(log, "scrollLeft", {
    configurable: true,
    get: () => at,
    set: (left: number) => {
      at = Math.trunc(left);
    },
  });
  for (let round = 0; round < 4; round++) spin(log, { deltaX: 0.5 });
  expect(log.scrollLeft).toBe(2);
});

test("a wheel the browser does not let the list cancel moves the list no further, and still pauses or follows at once", () => {
  const { log, onFollowChange, update } = mount({
    total: 300,
    items: lines(0, 300),
  });
  spin(log, { deltaY: -40, cancelable: false });
  expect(onFollowChange).toHaveBeenLastCalledWith(false);
  expect(log.scrollTop).toBe(19 * 300 - 600);
  update({ follow: false });
  scroll(log, 19 * 300 - 600 - 600);
  log.scrollTop = 19 * 300 - 600 - 300;
  spin(log, { deltaY: 300, cancelable: false });
  expect(log.scrollTop).toBe(19 * 300 - 600 - 300);
  expect(onFollowChange).not.toHaveBeenCalledWith(true);
  spin(log, { deltaY: 600, cancelable: false });
  expect(onFollowChange).toHaveBeenLastCalledWith(true);
});

test("paused, the wheel's scroll is the person's: lines that leave before its scroll event move the place with it, in the one write that holds the line", () => {
  const { log, onPlace, update } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  scroll(log, 19 * 120);
  spin(log, { deltaY: 40 });
  const writes = vi.spyOn(log, "scrollTop", "set");
  update({ items: lines(10, 310) });
  expect(writes.mock.calls).toEqual([[19 * 110 + 40]]);
  expect(onPlace).toHaveBeenLastCalledWith({ key: "122", offset: 2 });
});

test("following, a scroll the list did not write is the person's, and away from the end it pauses", () => {
  const { log, onFollowChange } = mount({ total: 300, items: lines(0, 300) });
  scroll(log, log.scrollTop);
  expect(onFollowChange).not.toHaveBeenCalled();
  scroll(log, 19 * 120);
  expect(onFollowChange).toHaveBeenLastCalledWith(false);
});

test("paused, a wheel down to the end follows on, though lines came before its scroll and the list followed before its event", () => {
  const { log, onFollowChange, update } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  scroll(log, 19 * 100);
  fireEvent.wheel(log, { deltaY: 100_000 });
  expect(onFollowChange).toHaveBeenLastCalledWith(true);
  log.scrollTop = 19 * 300 - 600;
  update({ follow: true, total: 310, items: lines(0, 310) });
  expect(log.scrollTop).toBe(19 * 310 - 600);
  scroll(log, log.scrollTop);
  expect(onFollowChange).not.toHaveBeenCalledWith(false);
});

test("following, the person's scroll down into the room a shorter list makes, its event not come yet, keeps it following, and the list writes the end at once", () => {
  const { log, onFollowChange } = mount({ total: 300, items: lines(0, 300) });
  shown = 500;
  log.scrollTop = 19 * 300 - 600 + 50;
  act(() => {
    resize();
  });
  expect(log.scrollTop).toBe(19 * 300 - 500);
  expect(onFollowChange).not.toHaveBeenCalled();
});

test("a touch that scrolls the list up pauses it", () => {
  const { log, onFollowChange } = mount({ total: 300, items: lines(0, 300) });
  act(() => {
    fireEvent.touchStart(log);
    log.scrollTop = 19 * 100;
    fireEvent.scroll(log);
    fireEvent.touchEnd(log);
  });
  expect(onFollowChange).toHaveBeenLastCalledWith(false);
});

test("paused, the person's scroll down to the end follows again, and the list's own does not while a pointer or a touch holds it", () => {
  const { log, onFollowChange, update } = mount({
    total: 300,
    items: lines(0, 300),
  });
  update({ follow: false });
  fireEvent.pointerDown(log);
  fireEvent.touchStart(log);
  update({ total: 250, items: lines(50, 300) });
  scroll(log, log.scrollTop);
  expect(onFollowChange).not.toHaveBeenCalled();
  scroll(log, 19 * 100);
  scroll(log, 19 * 250 - 600);
  expect(onFollowChange).toHaveBeenLastCalledWith(true);
});

test("paused at the end, the person's scroll up within a row of it keeps it paused", () => {
  const { log, onFollowChange, update } = mount({
    total: 300,
    items: lines(0, 300),
  });
  update({ follow: false });
  scroll(log, 19 * 300 - 600 - 5);
  expect(onFollowChange).not.toHaveBeenCalled();
});

function press(log: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  let left = true;
  act(() => {
    left = fireEvent.keyDown(log, { key, ...init });
  });
  return left;
}

const PAGE = 600 - 2 * 19;

test("the list's own keys, the same on every platform, move it itself at once, so neither the browser nor the workbench scrolls it: the page keys, Space, and ⌥ or ⌘ with an arrow", () => {
  const { log, onPlace } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  scroll(log, 19 * 100);
  const moves = [
    press(log, "PageDown"),
    log.scrollTop,
    press(log, " "),
    log.scrollTop,
    press(log, " ", { shiftKey: true }),
    press(log, "PageUp"),
    log.scrollTop,
    press(log, "ArrowDown", { altKey: true }),
    log.scrollTop,
    press(log, "ArrowUp", { altKey: true }),
    press(log, "ArrowUp", { metaKey: true }),
    log.scrollTop,
  ];
  expect(moves).toEqual([
    false,
    19 * 100 + PAGE,
    false,
    19 * 100 + 2 * PAGE,
    false,
    false,
    19 * 100,
    false,
    19 * 100 + PAGE,
    false,
    false,
    0,
  ]);
  expect(onPlace).toHaveBeenLastCalledWith({ key: "0", offset: 0 });
  expect([
    press(log, "ArrowDown"),
    press(log, "End"),
    press(log, "c", { metaKey: true }),
    press(log, "PageDown", { shiftKey: true }),
  ]).toEqual([true, true, true, true]);
  expect(log.scrollTop).toBe(0);
});

test("among the list's own keys, ⌃↑ and ⌃↓, alone or with ⌥, move it a page, and with ⇧, on which no engine scrolls, or with ⌘ they are not the list's", () => {
  const { log } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  scroll(log, 19 * 100);
  const moves = [
    press(log, "ArrowDown", { ctrlKey: true }),
    log.scrollTop,
    press(log, "ArrowDown", { ctrlKey: true, altKey: true }),
    log.scrollTop,
    press(log, "ArrowUp", { ctrlKey: true }),
    press(log, "ArrowUp", { ctrlKey: true, altKey: true }),
    log.scrollTop,
  ];
  expect(moves).toEqual([
    false,
    19 * 100 + PAGE,
    false,
    19 * 100 + 2 * PAGE,
    false,
    false,
    19 * 100,
  ]);
  expect([
    press(log, "ArrowDown", { ctrlKey: true, shiftKey: true }),
    press(log, "ArrowUp", { ctrlKey: true, shiftKey: true }),
    press(log, "ArrowDown", { ctrlKey: true, shiftKey: true, altKey: true }),
    press(log, "ArrowDown", { ctrlKey: true, metaKey: true }),
    press(log, " ", { ctrlKey: true }),
  ]).toEqual([true, true, true, true, true]);
  expect(log.scrollTop).toBe(19 * 100);
});

test("among the list's own keys, ⌃Home goes to the top and ⌃End follows again, as ⌘↑ and ⌘↓ do", () => {
  const { log, onFollowChange } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  scroll(log, 19 * 100);
  expect(press(log, "End", { ctrlKey: true })).toBe(false);
  expect(onFollowChange).toHaveBeenLastCalledWith(true);
  expect(press(log, "Home", { ctrlKey: true })).toBe(false);
  expect(log.scrollTop).toBe(0);
});

test("in a short list a page moves seven eighths of it, never the wrong way, and at least a pixel", () => {
  const pages = [1, 30, 50, 90, 400].map((height) => {
    shown = height;
    const { log } = mount({
      follow: false,
      total: 300,
      items: lines(0, 300),
    });
    scroll(log, 19 * 100);
    press(log, "PageDown");
    const down = log.scrollTop - 19 * 100;
    press(log, "PageUp");
    const up = log.scrollTop - 19 * 100 - down;
    cleanup();
    return [height, down, up];
  });
  expect(pages).toEqual([
    [1, 1, -1],
    [30, 26, -26],
    [50, 43, -43],
    [90, 78, -78],
    [400, 400 - 38, -(400 - 38)],
  ]);
});

test("paused, a page down that reaches the end follows again, one at the end too, and ⌘↓ at once", () => {
  const { log, onFollowChange, update } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  scroll(log, 19 * 300 - 600 - 100);
  press(log, "PageDown");
  expect(log.scrollTop).toBe(19 * 300 - 600);
  expect(onFollowChange).toHaveBeenLastCalledWith(true);
  onFollowChange.mockClear();
  update({ total: 310, items: lines(0, 310) });
  scroll(log, 19 * 310 - 600 - 5);
  update({ total: 320, items: lines(0, 320) });
  press(log, " ");
  expect(onFollowChange).toHaveBeenLastCalledWith(true);
  onFollowChange.mockClear();
  scroll(log, 19 * 100);
  press(log, "ArrowDown", { metaKey: true });
  expect(onFollowChange).toHaveBeenLastCalledWith(true);
});

test("paused at the end, a page down follows again though it cannot scroll", () => {
  const { log, onFollowChange } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
    place: { key: "268", offset: 8 },
  });
  expect(log.scrollTop).toBe(19 * 300 - 600);
  press(log, "PageDown");
  expect(onFollowChange).toHaveBeenLastCalledWith(true);
});

test("a key that does not scroll leaves nothing behind that a later scroll follows at", () => {
  const { log, onFollowChange, update } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  scroll(log, 19 * 100);
  fireEvent.keyDown(log, { key: "c", metaKey: true });
  update({ total: 400, items: lines(0, 400) });
  scroll(log, 19 * 200);
  scroll(log, 19 * 300 - 600);
  expect(onFollowChange).not.toHaveBeenCalledWith(true);
});

test("following, the person's scroll back to the end before their pause reached `follow` follows on as lines come", () => {
  const { log, onFollowChange, update } = mount({
    total: 300,
    items: lines(0, 300),
  });
  scroll(log, 19 * 100);
  expect(onFollowChange).toHaveBeenLastCalledWith(false);
  scroll(log, 19 * 300 - 600);
  expect(onFollowChange).toHaveBeenLastCalledWith(true);
  update({ total: 310, items: lines(0, 310) });
  expect(log.scrollTop).toBe(19 * 310 - 600);
});

test("following, a reveal is no step's and moves nothing, not even once the list pauses", () => {
  const { log, onFollowChange, onPlace, update } = mount({
    total: 300,
    start: 260,
    items: lines(260, 300),
  });
  update({ reveal: { key: "280", token: 1 } });
  update({ total: 320, start: 280, items: lines(280, 320) });
  expect(log.scrollTop).toBe(19 * 320 - 600);
  update({ follow: false });
  expect(log.scrollTop).toBe(19 * 320 - 600);
  expect(onFollowChange).not.toHaveBeenCalled();
  expect(onPlace).not.toHaveBeenCalledWith(
    expect.objectContaining({ key: "280" }),
  );
});

test("paused near the end, a list made taller holds where the end cut it short, and the lines that come next move nothing", () => {
  const { log, onPlace, update } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  scroll(log, 19 * 300 - 600 - 150);
  act(() => {
    shown = 900;
    resize();
  });
  expect(log.scrollTop).toBe(19 * 300 - 900);
  expect(onPlace).toHaveBeenLastCalledWith({
    key: "260",
    offset: 19 * 300 - 900 - 19 * 260,
  });
  update({ total: 320, items: lines(0, 320) });
  expect(log.scrollTop).toBe(19 * 300 - 900);
});

test("paused, the end cutting the list short as lines leave on either side of its top is no scroll of the person's", () => {
  const { log, onPlace, update } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  scroll(log, 19 * 260);
  update({ total: 280, items: lines(10, 290) });
  expect(log.scrollTop).toBe(19 * 280 - 600);
  expect(onPlace).toHaveBeenLastCalledWith({
    key: "260",
    offset: 19 * 280 - 600 - 19 * 250,
  });
});

test("paused, the person's scroll whose event has not come when lines leave before the top moves the place with it", () => {
  const { log, onPlace, update } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  scroll(log, 19 * 120);
  log.scrollTop = 19 * 130;
  update({ items: lines(10, 310) });
  expect(log.scrollTop).toBe(19 * 120);
  expect(onPlace).toHaveBeenLastCalledWith({ key: "130", offset: 0 });
});

test("a line revealed near the end stands where the end lets it, says so as it lands, and the lines that come next move nothing", () => {
  const { log, onPlace, update } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  update({ reveal: { key: "295", token: 1 } });
  expect(log.scrollTop).toBe(19 * 300 - 600);
  expect(onPlace).toHaveBeenLastCalledWith({
    key: "295",
    offset: 19 * 300 - 600 - 19 * 295,
  });
  expect(onPlace).not.toHaveBeenCalledWith({ key: "295", offset: CENTRE });
  update({ total: 320, items: lines(0, 320) });
  expect(log.scrollTop).toBe(19 * 300 - 600);
});

test("paused, the lines that came meanwhile show on a button that follows again", () => {
  const { onFollowChange } = mount({ follow: false, fresh: 2 });
  act(() => {
    screen.getByRole("button", { name: "2 new lines" }).click();
  });
  expect(onFollowChange).toHaveBeenCalledWith(true);
});

test("paused, the list keeps its top line in place as lines leave before it, and the virtualizer never scrolls it", () => {
  const { log, update } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  const scrolled = vi.spyOn(HTMLElement.prototype, "scrollTo");
  scroll(log, 19 * 120);
  update({ total: 250, items: lines(50, 300) });
  expect(log.scrollTop).toBe(19 * 70);
  update({ reveal: { key: "200", token: 1 } });
  expect(log.scrollTop).toBe(19 * 150 + CENTRE);
  update({ follow: true });
  expect(log.scrollTop).toBe(19 * 250 - 600);
  expect(scrolled).not.toHaveBeenCalled();
});

test("paused, turning wrap on keeps the top line where it stood as its rows are measured", () => {
  const { log, onPlace, update } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  scroll(log, 19 * 120 + 8);
  wrapped();
  update({ wrap: true });
  act(() => {
    resize();
  });
  expect(log.scrollTop - startOf(log, "120")).toBe(8);
  expect(onPlace).toHaveBeenLastCalledWith({ key: "120", offset: 8 });
});

test("paused at the end, turning wrap on keeps the top line where it stood, though the rows it measured grow the list only a render later", async () => {
  const { log, update } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
    place: { key: "268", offset: 8 },
  });
  scroll(log, log.scrollTop);
  await act(() => new Promise((done) => setTimeout(done, 200)));
  wrapped();
  update({ wrap: true });
  act(() => {
    resize();
  });
  expect(log.scrollTop - startOf(log, "268")).toBe(8);
});

test("with wrap, a new window keeps the sizes of the rows that just left it, so the lines below them stay put", () => {
  wrapped();
  const { log, update } = mount({
    follow: false,
    wrap: true,
    total: 300,
    start: 60,
    items: lines(60, 300),
  });
  for (const top of [19 * 100, 19 * 130]) {
    scroll(log, top);
    act(() => {
      resize();
    });
  }
  scroll(log, log.scrollTop);
  const before = log.scrollTop;
  update({ start: 115, items: lines(115, 300) });
  expect(log.scrollTop).toBe(before);
  update({ start: 200, items: lines(200, 300) });
  expect(log.scrollTop).toBe(before);
  update({ start: 105, items: lines(105, 290) });
  expect(log.scrollTop).toBe(before);
});

test("with wrap, a new window that moves the lines, as the bound drops some before them and a lagging stream merges some in, keeps the sizes of the rows that left it where their lines now stand", () => {
  wrapped();
  const { log, onPlace, update } = mount({
    follow: false,
    wrap: true,
    total: 300,
    start: 60,
    items: lines(60, 300),
  });
  for (const top of [19 * 100, 3000, 2300]) {
    scroll(log, top);
    act(() => {
      resize();
    });
  }
  scroll(log, log.scrollTop);
  expect(onPlace).toHaveBeenLastCalledWith({ key: "113", offset: 1 });
  update({ start: 103, items: lines(103, 153) });
  const top = log.scrollTop;
  const length = log.scrollHeight;
  update({
    total: 295,
    start: 93,
    items: [
      ...lines(103, 143),
      ...[1000, 1001, 1003, 1004, 1006].map((key) => line(key)),
      ...lines(143, 153),
    ],
  });
  expect([log.scrollTop - top, log.scrollHeight - length]).toEqual([
    -10 * 19,
    -10 * 19 + 5 * 19,
  ]);
});

test("with wrap, a revealed line stays centred as the rows before it are measured", () => {
  wrapped();
  const { log, update } = mount({
    follow: false,
    wrap: true,
    total: 300,
    items: lines(0, 300),
  });
  update({ reveal: { key: "200", token: 1 } });
  for (let round = 0; round < 4; round++) {
    scroll(log, log.scrollTop);
    act(() => {
      resize();
    });
  }
  expect(log.scrollTop - startOf(log, "200")).toBe(CENTRE);
});

test("with wrap, a held line is placed by its own start as lines leave before it", () => {
  wrapped();
  const { log, onPlace, update } = mount({
    follow: false,
    wrap: true,
    total: 300,
    items: lines(0, 300),
  });
  scroll(log, 1000);
  const held = onPlace.mock.lastCall?.[0] as { key: string; offset: number };
  update({ total: 290, items: lines(10, 300) });
  scroll(log, log.scrollTop);
  expect(log.scrollTop - startOf(log, held.key)).toBe(held.offset);
});

test("following with wrap through many lines, the rows on screen keep their sizes", () => {
  wrapped();
  const { log, update } = mount({
    wrap: true,
    total: 100,
    start: 60,
    items: lines(60, 100),
  });
  for (let end = 110; end <= 1200; end += 10) {
    update({ total: end, start: end - 40, items: lines(end - 40, end) });
    scroll(log, log.scrollTop);
    act(() => {
      resize();
    });
    const rows = [...log.querySelectorAll<HTMLElement>("[data-index]")]
      .map((row) => ({
        index: Number(row.dataset.index),
        start: Number(/translateY\((.+)px\)/.exec(row.style.transform)?.[1]),
        height: height(row),
      }))
      .sort((a, b) => a.index - b.index);
    const gaps = rows
      .slice(1)
      .map(
        (row, at) =>
          row.start - (rows[at]?.start ?? 0) - (rows[at]?.height ?? 0),
      );
    expect({ end, gaps: gaps.filter((gap) => gap !== 0) }).toEqual({
      end,
      gaps: [],
    });
  }
});

test("a list that mounts paused goes back to where it stood", () => {
  const { log, onWindow } = mount({
    follow: false,
    total: 300,
    start: 100,
    items: lines(100, 200),
    place: { key: "150", offset: 7 },
  });
  expect(onWindow).toHaveBeenCalledWith(around("150"));
  expect(log.scrollTop).toBe(19 * 150 + 7);
});

test("a place that is not loaded waits for the answer around its line, not for a window asked before", () => {
  const { log, onWindow, onPlace, update } = mount({
    follow: false,
    total: 600,
    start: 400,
    items: lines(400, 550),
    around: { key: "450", index: 450 },
    place: { key: "150", offset: 7 },
  });
  expect(onWindow).toHaveBeenLastCalledWith(around("150"));
  expect(log.scrollTop).toBe(0);
  update({
    start: 110,
    items: lines(110, 221),
    around: { key: "150", index: 150 },
  });
  expect(log.scrollTop).toBe(19 * 150 + 7);
  expect(onPlace).toHaveBeenLastCalledWith({ key: "150", offset: 7 });
});

test("an answer whose line the view no longer keeps places the line where it would stand, and the list holds it there", () => {
  const { log, update } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  scroll(log, 19 * 120 + 5);
  const kept = [...lines(60, 100), ...lines(150, 190)];
  update({
    total: 250,
    start: 60,
    items: kept,
    around: { key: "120", index: 100 },
  });
  expect(log.scrollTop).toBe(19 * 100 + 5);
  update({ total: 200, start: 10, around: { key: "120", index: 50 } });
  expect(log.scrollTop).toBe(19 * 50 + 5);
});

test("a held line that left the window asks around itself again when the answer is around another line", () => {
  const { log, onWindow, update } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  scroll(log, 19 * 120);
  scroll(log, 19 * 130);
  expect(onWindow).toHaveBeenLastCalledWith(around("120"));
  update({
    total: 299,
    start: 80,
    items: [...lines(80, 130), ...lines(131, 200)],
    around: { key: "120", index: 120 },
  });
  expect(onWindow).toHaveBeenLastCalledWith(around("130"));
});

test("a line to reveal that is not loaded is asked for around its key, and is the place the list goes to", () => {
  const { onWindow, onPlace, update } = mount({
    follow: false,
    total: 5000,
    start: 4900,
    items: lines(4900, 5000),
  });
  update({ reveal: { key: "1200", token: 1 } });
  expect(onWindow).toHaveBeenLastCalledWith(around("1200"));
  expect(onPlace).toHaveBeenLastCalledWith({
    key: "1200",
    offset: -Math.round((600 - 19) / 2),
  });
});

test("a loaded line to reveal replaces a reveal still loading, whose answer then moves nothing", () => {
  const { log, update } = mount({
    follow: false,
    total: 5000,
    start: 4900,
    items: lines(4900, 5000),
  });
  update({ reveal: { key: "1200", token: 1 } });
  update({ reveal: { key: "4910", token: 2 } });
  expect(log.scrollTop).toBe(19 * 4910 + CENTRE);
  update({
    start: 1160,
    items: lines(1160, 1272),
    around: { key: "1200", index: 1200 },
  });
  expect(log.scrollTop).toBe(19 * 4910 + CENTRE);
});

test("a reveal takes in the person's scroll whose event has not come, and lands on a loaded line", () => {
  const { log, update } = mount({
    follow: false,
    total: 5000,
    start: 4900,
    items: lines(4900, 5000),
  });
  scroll(log, 19 * 4950);
  log.scrollTop = 19 * 4960;
  update({ reveal: { key: "4910", token: 1 } });
  act(() => {
    fireEvent.scroll(log);
  });
  expect(log.scrollTop).toBe(19 * 4910 + CENTRE);
});

test("a reveal takes in the person's scroll whose event has not come, and lands on a line once its answer comes", () => {
  const { log, onWindow, update } = mount({
    follow: false,
    total: 5000,
    start: 4900,
    items: lines(4900, 5000),
  });
  scroll(log, 19 * 4950);
  log.scrollTop = 19 * 4960;
  update({ reveal: { key: "1200", token: 1 } });
  expect(onWindow).toHaveBeenLastCalledWith(around("1200"));
  act(() => {
    fireEvent.scroll(log);
  });
  update({
    start: 1160,
    items: lines(1160, 1272),
    around: { key: "1200", index: 1200 },
  });
  expect(log.scrollTop).toBe(19 * 1200 + CENTRE);
});

test("a list shown again while a reveal loads still lands on the line", () => {
  const { log, update } = mount({
    follow: false,
    total: 5000,
    start: 4900,
    items: lines(4900, 5000),
  });
  scroll(log, 19 * 4950);
  update({ reveal: { key: "1200", token: 1 } });
  hide(log);
  show(log);
  update({ fresh: 1 });
  update({
    start: 1160,
    items: lines(1160, 1272),
    around: { key: "1200", index: 1200 },
  });
  expect(log.scrollTop).toBe(19 * 1200 + CENTRE);
});

test("a revealed line stays where it was revealed as lines leave before it ahead of the reveal's scroll event", () => {
  const { log, update } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  update({ reveal: { key: "150", token: 1 } });
  expect(log.scrollTop).toBe(19 * 150 + CENTRE);
  update({ total: 250, items: lines(50, 300) });
  expect(log.scrollTop).toBe(19 * 100 + CENTRE);
});

test("a list that mounts with a reveal it was given before goes to its place, not to the revealed line", () => {
  const { log, onWindow } = mount({
    follow: false,
    total: 5000,
    start: 100,
    items: lines(100, 200),
    place: { key: "150", offset: 7 },
    reveal: { key: "4950", token: 3 },
  });
  expect(log.scrollTop).toBe(19 * 150 + 7);
  expect(onWindow).not.toHaveBeenCalledWith(around("4950"));
});

test("paused, a jump past what is loaded asks for the lines there by index, and holds and reports the top line once they come", () => {
  const { log, onWindow, onPlace, update } = mount({
    follow: false,
    total: 5000,
    start: 4900,
    items: lines(4900, 5000),
  });
  scroll(log, 19 * 4950);
  expect(onWindow).toHaveBeenLastCalledWith(around("4950"));
  wheel(log, 19 * 1000);
  expect(onWindow).toHaveBeenLastCalledWith(
    expect.objectContaining({ start: expect.any(Number) as number }),
  );
  update({ start: 960, items: lines(960, 1080) });
  expect(onPlace).toHaveBeenLastCalledWith({ key: "1000", offset: 0 });
  expect(onWindow).toHaveBeenLastCalledWith(around("1000"));
});

test("the person's scroll ends a place still loading", () => {
  const { log, onWindow, update } = mount({
    follow: false,
    total: 300,
    items: lines(0, 100),
    place: { key: "250", offset: 0 },
  });
  expect(onWindow).toHaveBeenLastCalledWith(around("250"));
  wheel(log, 19 * 50);
  expect(onWindow).toHaveBeenLastCalledWith(around("50"));
  update({
    start: 210,
    items: lines(210, 300),
    around: { key: "250", index: 250 },
  });
  expect(log.scrollTop).toBe(19 * 50);
});

test("following again ends a place still loading", () => {
  const { log, onPlace, update } = mount({
    follow: false,
    total: 300,
    items: lines(0, 100),
    place: { key: "250", offset: 0 },
  });
  update({ follow: true });
  update({
    start: 210,
    items: lines(210, 300),
    around: { key: "250", index: 250 },
  });
  expect(log.scrollTop).toBe(19 * 300 - 600);
  update({ follow: false });
  expect(onPlace).toHaveBeenLastCalledWith({
    key: "268",
    offset: 19 * 300 - 600 - 19 * 268,
  });
});

test("the list's keys scroll it as the person does, pausing it on the way up", () => {
  let controller: ListController | undefined;
  const { log, onFollowChange, onWindow, update } = mount({
    total: 5000,
    start: 4960,
    items: lines(4960, 5000),
    register: (_element, given) => {
      controller = given;
      return () => undefined;
    },
  });
  act(() => {
    controller?.move(-1);
  });
  expect(onFollowChange).toHaveBeenLastCalledWith(false);
  expect(log.scrollTop).toBe(19 * 5000 - 600 - 19);
  act(() => {
    controller?.moveToEdge("first");
  });
  expect(log.scrollTop).toBe(0);
  update({ follow: false });
  expect(onWindow).toHaveBeenLastCalledWith({
    start: 0,
    end: expect.any(Number) as number,
  });
});

test("a list hidden while paused shows its top line in place again", () => {
  const { log, update } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  scroll(log, 19 * 120 + 5);
  hide(log);
  update({ total: 250, items: lines(50, 300) });
  show(log);
  expect(log.scrollTop).toBe(19 * 70 + 5);
});

test("a list hidden while following shows the end again", () => {
  const { log, update } = mount({ total: 300, items: lines(0, 300) });
  hide(log);
  update({ total: 400, start: 360, items: lines(360, 400) });
  show(log);
  expect(log.scrollTop).toBe(19 * 400 - 600);
});

test("a list paused while hidden holds the line it stood at, not the top it shows again at", () => {
  const { log, onPlace, update } = mount({
    total: 300,
    items: lines(0, 300),
  });
  hide(log);
  update({ follow: false });
  show(log);
  expect(log.scrollTop).toBe(19 * 300 - 600);
  expect(onPlace).toHaveBeenLastCalledWith({ key: "268", offset: 8 });
});

test("a marker draws its icon, tag and words", () => {
  mount({
    total: 1,
    items: [
      {
        kind: "marker",
        key: "m",
        icon: ScrollText,
        tone: "error",
        tag: "h8lbx",
        text: "Container api exited with code 1",
      },
    ],
  });
  expect(screen.getByText("Container api exited with code 1")).toBeTruthy();
});

test("styled text splits at runs and marks, the current mark filled", () => {
  render(
    <p data-testid="text">
      <StyledText
        text="WARN db refused"
        runs={[
          {
            start: 0,
            end: 4,
            fg: "yellow",
            bg: null,
            bold: true,
            dim: false,
            italic: false,
            underline: false,
          },
        ]}
        marks={[{ start: 8, end: 15, current: true }]}
      />
    </p>,
  );
  const spans = [...screen.getByTestId("text").querySelectorAll("span")];
  expect(spans.map((span) => [span.textContent, span.className])).toEqual([
    ["WARN", "text-ansi-yellow font-semibold"],
    ["refused", "rounded-xs bg-mark-current text-mark-current-foreground"],
  ]);
  expect(screen.getByTestId("text").textContent).toBe("WARN db refused");
});

test("on a background, black and no colour are the theme's text", () => {
  render(
    <p data-testid="text">
      <StyledText
        text="FAIL"
        runs={[
          {
            start: 0,
            end: 4,
            fg: "black",
            bg: "yellow",
            bold: false,
            dim: false,
            italic: false,
            underline: false,
          },
        ]}
        marks={[]}
      />
    </p>,
  );
  expect(screen.getByText("FAIL").className).toBe(
    "text-foreground bg-ansi-yellow/25",
  );
});
