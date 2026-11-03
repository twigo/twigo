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

test("paused, it asks for a range in blocks around what it shows", () => {
  const { onWindow } = list({ follow: false });
  expect(onWindow).toHaveBeenLastCalledWith({ start: 0, end: 50 });
});

test("a wheel up pauses following", () => {
  const { onFollowChange } = list();
  fireEvent.wheel(screen.getByRole("log"), { deltaY: -40 });
  expect(onFollowChange).toHaveBeenCalledWith(false);
});

test("paused, the lines that came meanwhile show on a button that follows again", () => {
  const { rerender, onFollowChange, onWindow, items } = list({ follow: false });
  const more = [...items, line(5), line(6)];
  rerender(
    <LineList
      label="Logs"
      total={7}
      start={0}
      items={more}
      follow={false}
      wrap={false}
      timestamps
      onWindow={onWindow}
      onFollowChange={onFollowChange}
    />,
  );
  act(() => {
    screen.getByRole("button", { name: "2 new lines" }).click();
  });
  expect(onFollowChange).toHaveBeenCalledWith(true);
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
