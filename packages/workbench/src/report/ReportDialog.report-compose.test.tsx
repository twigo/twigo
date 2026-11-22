import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openReport } from "./testing";

beforeEach(() => {
  history.replaceState(null, "", "/?variant=report:compose");
});

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
});

const write = (name: string, value: string) => {
  fireEvent.change(screen.getByRole("textbox", { name }), {
    target: { value },
  });
};

test("report:compose: the title and what happened go in the link, and the log alone on the clipboard", async () => {
  const { calls } = await openReport();
  write("Title", "  List stops  ");
  write("What happened", "I scrolled the pods list.");
  fireEvent.click(screen.getByRole("button", { name: "Open Issue on GitHub" }));
  await screen.findByText(/paste it into Logs/);
  expect(
    calls.find(([command]) => command === "report_open_issue")?.[1],
  ).toEqual({
    facts: ["twigo", "system", "engine", "kubernetes", "lastPanic"],
    title: "List stops",
    description: "I scrolled the pods list.",
  });
  const clip = calls.find(
    ([command]) => command === "clipboard",
  )?.[1] as string;
  expect(clip.startsWith("2026-11-22T21:14:00Z INFO")).toBe(true);
});

test("report:compose: a title or description left empty is not sent, and what is written leads the saved text", async () => {
  const { calls } = await openReport();
  write("What happened", "It froze.");
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await act(() => Promise.resolve());
  const copied = calls.find(
    ([command]) => command === "clipboard",
  )?.[1] as string;
  expect(copied).toContain("\n\nIt froze.\n\n2026-11-22T21:14:00Z INFO");
  fireEvent.click(screen.getByRole("button", { name: "Open Issue on GitHub" }));
  await screen.findByText(/paste it into Logs/);
  expect(
    calls.find(([command]) => command === "report_open_issue")?.[1],
  ).toMatchObject({ title: null, description: "It froze." });
});

test("report:compose: a link that cut the description keeps the dialog, says so, and copies the description in a click of its own", async () => {
  const { calls } = await openReport({}, "reportCut");
  write("What happened", "  A long story  ");
  fireEvent.click(screen.getByRole("button", { name: "Open Issue on GitHub" }));
  const dialog = screen.getByRole("dialog");
  const status = await within(dialog).findByRole("status");
  expect(status.textContent).toContain("cut your description");

  const before = calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Copy description" }));
  expect(calls.slice(before)).toEqual([["clipboard", "A long story"]]);
});
