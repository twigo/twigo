import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { ScrollText } from "lucide-react";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { LineList, type LineItem } from "./LineList";
import { StyledText } from "./StyledText";

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 600,
  });
});

afterAll(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
});

afterEach(cleanup);

const line = (key: number, text = `line ${String(key)}`): LineItem => ({
  kind: "line",
  key: String(key),
  tag: "h8lbx",
  time: "10:41:02.402",
  text,
  runs: [],
  marks: [],
});

function list(props: Partial<Parameters<typeof LineList>[0]> = {}) {
  const onWindow = vi.fn();
  const onFollowChange = vi.fn();
  const items = Array.from({ length: 5 }, (_, index) => line(index));
  const view = render(
    <LineList
      label="Logs"
      total={5}
      start={0}
      items={items}
      follow
      wrap={false}
      timestamps
      fresh={0}
      onWindow={onWindow}
      onFollowChange={onFollowChange}
      {...props}
    />,
  );
  return { ...view, onWindow, onFollowChange, items };
}

test("following, it asks for the tail", () => {
  const { onWindow } = list();
  expect(onWindow).toHaveBeenLastCalledWith({ tail: 40 });
});

test("paused, it asks for a range around what it shows, then around its top line once it is loaded", () => {
  const { onWindow } = list({ follow: false });
  expect(onWindow).toHaveBeenCalledWith({ start: 0, end: 44 });
  expect(onWindow).toHaveBeenLastCalledWith({
    around: "0",
    before: 40,
    after: 40,
  });
});

test("paused, a scroll asks for the lines around the top line by its key", () => {
  const { onWindow, onFollowChange } = list({
    follow: false,
    total: 300,
    items: Array.from({ length: 300 }, (_, index) => line(index)),
  });
  const log = screen.getByRole("log");
  Object.defineProperty(log, "scrollHeight", { value: 19 * 300 });
  act(() => {
    log.scrollTop = 19 * 120;
    fireEvent.scroll(log);
  });
  expect(onWindow).toHaveBeenLastCalledWith({
    around: "120",
    before: 40,
    after: 40,
  });
  expect(onFollowChange).not.toHaveBeenCalledWith(true);
});

test("a wheel up pauses following", () => {
  const { onFollowChange } = list();
  fireEvent.wheel(screen.getByRole("log"), { deltaY: -40 });
  expect(onFollowChange).toHaveBeenCalledWith(false);
});

test("paused, the lines that came meanwhile show on a button that follows again", () => {
  const { onFollowChange } = list({ follow: false, fresh: 2 });
  act(() => {
    screen.getByRole("button", { name: "2 new lines" }).click();
  });
  expect(onFollowChange).toHaveBeenCalledWith(true);
});

test("paused, the top line stays put as lines leave before it", () => {
  const items = Array.from({ length: 300 }, (_, index) => line(index));
  const { rerender, onWindow, onFollowChange } = list({
    follow: false,
    total: 300,
    items,
  });
  const log = screen.getByRole("log");
  act(() => {
    log.scrollTop = 19 * 120;
    fireEvent.scroll(log);
  });
  rerender(
    <LineList
      label="Logs"
      total={250}
      start={0}
      items={items.slice(50)}
      follow={false}
      wrap={false}
      timestamps
      fresh={0}
      onWindow={onWindow}
      onFollowChange={onFollowChange}
    />,
  );
  expect(log.scrollTop).toBe(19 * 70);
});

test("a list that mounts paused goes back to where it stood", () => {
  const { onWindow } = list({
    follow: false,
    total: 300,
    start: 100,
    items: Array.from({ length: 100 }, (_, index) => line(index + 100)),
    place: { key: "150", offset: 7 },
  });
  expect(onWindow).toHaveBeenCalledWith({
    around: "150",
    before: 40,
    after: 40,
  });
  expect(screen.getByRole("log").scrollTop).toBe(19 * 150 + 7);
});

test("a marker draws its icon, tag and words", () => {
  list({
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

test("paused, a jump past what is loaded asks for the lines there by index", () => {
  const { onWindow } = list({
    follow: false,
    total: 5000,
    start: 4900,
    items: Array.from({ length: 100 }, (_, index) => line(index + 4900)),
  });
  const log = screen.getByRole("log");
  Object.defineProperty(log, "scrollHeight", { value: 19 * 5000 });
  act(() => {
    log.scrollTop = 19 * 4950;
    fireEvent.scroll(log);
  });
  expect(onWindow).toHaveBeenLastCalledWith({
    around: "4950",
    before: 40,
    after: 40,
  });
  act(() => {
    log.scrollTop = 19 * 1000;
    fireEvent.scroll(log);
  });
  expect(onWindow).toHaveBeenLastCalledWith(
    expect.objectContaining({ start: expect.any(Number) as number }),
  );
});

test("a line to reveal that is not loaded is asked for around its key", () => {
  const { onWindow } = list({
    follow: false,
    total: 5000,
    start: 4900,
    items: Array.from({ length: 100 }, (_, index) => line(index + 4900)),
    reveal: { key: "1200", token: 1 },
  });
  expect(onWindow).toHaveBeenLastCalledWith({
    around: "1200",
    before: 40,
    after: 40,
  });
});

test("a kept place whose line the buffer dropped leaves the list holding the line now on top", () => {
  const { onWindow } = list({
    follow: false,
    total: 300,
    start: 0,
    items: Array.from({ length: 100 }, (_, index) => line(index + 200)),
    place: { key: "150", offset: 0 },
  });
  expect(onWindow).toHaveBeenCalledWith({
    around: "150",
    before: 40,
    after: 40,
  });
  expect(onWindow).toHaveBeenLastCalledWith({
    around: "200",
    before: 40,
    after: 40,
  });
});
