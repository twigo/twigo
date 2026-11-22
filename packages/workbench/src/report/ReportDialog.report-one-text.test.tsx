import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openReport } from "./testing";

beforeEach(() => {
  history.replaceState(null, "", "/?variant=report:one-text");
});

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
});

test("report:one-text shows one editable text with the facts above the log, and no list of facts", async () => {
  await openReport();
  expect(screen.queryByRole("region", { name: "In the issue" })).toBeNull();
  const text = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Report",
  }).value;
  expect(text.startsWith("Twigo: 0.1.0 (3f2a9c1)\nSystem: ")).toBe(true);
  expect(text).toContain("\n\n2026-11-22T21:14:00Z INFO");
});

test("report:one-text: Open Issue copies the whole text, edited, and opens the bare template", async () => {
  const { calls } = await openReport();
  const field = screen.getByRole("textbox", { name: "Report" });
  fireEvent.change(field, { target: { value: "my own words" } });
  fireEvent.click(screen.getByRole("button", { name: "Open Issue on GitHub" }));
  await screen.findByText(/paste it into Logs/);
  expect(calls.find(([command]) => command === "clipboard")?.[1]).toBe(
    "my own words",
  );
  expect(
    calls.find(([command]) => command === "report_open_issue")?.[1],
  ).toEqual({
    facts: [],
    title: null,
    description: null,
  });
});
