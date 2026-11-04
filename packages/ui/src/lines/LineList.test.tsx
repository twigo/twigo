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
    fireEvent.wheel(log, { deltaY: top < log.scrollTop ? -40 : 40 });
    log.scrollTop = top;
    fireEvent.scroll(log);
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

test("a wheel up pauses following", () => {
  const { log, onFollowChange } = mount();
  fireEvent.wheel(log, { deltaY: -40 });
  expect(onFollowChange).toHaveBeenCalledWith(false);
});

test("paused, a wheel down that reaches the end follows again at once, and one short of it does not, though the browser scrolled by it first", () => {
  const { log, onFollowChange } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  log.scrollTop = 19 * 300 - 600 - 40;
  fireEvent.wheel(log, { deltaY: 19 * 300 - 600 - 40 });
  expect(onFollowChange).not.toHaveBeenCalled();
  log.scrollTop = 0;
  fireEvent.wheel(log, { deltaY: 19 * 300 - 600 });
  expect(onFollowChange).toHaveBeenLastCalledWith(true);
});

test("following, a scroll the list did not write is the person's, and away from the end it pauses", () => {
  const { log, onFollowChange } = mount({ total: 300, items: lines(0, 300) });
  scroll(log, log.scrollTop);
  expect(onFollowChange).not.toHaveBeenCalled();
  scroll(log, 19 * 120);
  expect(onFollowChange).toHaveBeenLastCalledWith(false);
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

test("paused, a key's scroll the browser took to the end as it stood follows again, though lines came before it got there", () => {
  const { log, onFollowChange, update } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  fireEvent.keyDown(log, { key: "End" });
  update({ total: 310, items: lines(0, 310) });
  scroll(log, 19 * 300 - 600);
  expect(onFollowChange).toHaveBeenLastCalledWith(true);
});

test("paused at the buffer's bound, a key's scroll to the end follows again, though the lines it began over moved before it got there", () => {
  const { log, onFollowChange, update } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  scroll(log, 19 * 120);
  fireEvent.keyDown(log, { key: "End" });
  update({ items: lines(10, 310) });
  expect(log.scrollTop).toBe(19 * 110);
  scroll(log, 19 * 300 - 600 - 19 * 10);
  expect(onFollowChange).toHaveBeenLastCalledWith(true);
});

test("a key's end is the end only for the scroll it began, not after a wheel or following again", () => {
  const { log, onFollowChange, update } = mount({
    follow: false,
    total: 300,
    items: lines(0, 300),
  });
  fireEvent.keyDown(log, { key: "End" });
  update({ total: 400, items: lines(0, 400) });
  fireEvent.wheel(log, { deltaY: -40 });
  scroll(log, 19 * 200);
  scroll(log, 19 * 300 - 600);
  expect(onFollowChange).not.toHaveBeenCalledWith(true);
  fireEvent.keyDown(log, { key: "End" });
  update({ follow: true });
  update({ total: 500, items: lines(0, 500) });
  update({ follow: false });
  scroll(log, 19 * 200);
  scroll(log, 19 * 400 - 600);
  expect(onFollowChange).not.toHaveBeenCalledWith(true);
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
