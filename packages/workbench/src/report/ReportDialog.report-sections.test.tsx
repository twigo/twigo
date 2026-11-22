import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { openReport } from "./testing";

afterEach(cleanup);

const click = (name: string | RegExp) => {
  fireEvent.click(screen.getByRole("button", { name }));
};

test("report:sections, the default: the facts are read-only and only the optional ones have a tick, and the log is its own field", async () => {
  await openReport();
  const facts = within(screen.getByRole("region", { name: "In the issue" }));
  expect(facts.getByText("0.1.0 (3f2a9c1)")).toBeTruthy();
  expect(
    facts
      .getAllByRole("checkbox")
      .map((box) => (box as HTMLInputElement).checked),
  ).toEqual([true, true]);
  const log = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Log",
  });
  expect(log.value).toContain("twigo_log::facts Twigo started");
  expect(log.value).not.toContain("Twigo: 0.1.0");
  expect(
    screen.getByText(
      "Twigo hid 11 names, 3 paths, 1 token, 4 addresses and 4 quoted strings; read it before you paste.",
    ),
  ).toBeTruthy();
});

test("report:sections: Open Issue states the facts left ticked and no more, and copies the log alone", async () => {
  const { calls } = await openReport();
  fireEvent.click(screen.getByRole("checkbox", { name: /v1\.33\.4/ }));
  click("Open Issue on GitHub");
  await screen.findByText(/paste it into Logs/);
  const log = (calls.find(([command]) => command === "clipboard")?.[1] ??
    "") as string;
  expect(log.startsWith("2026-11-22T21:14:00Z INFO")).toBe(true);
  expect(
    calls.find(([command]) => command === "report_open_issue")?.[1],
  ).toEqual({
    facts: ["twigo", "system", "engine", "lastPanic"],
    title: null,
    description: null,
  });
});

test("report:sections: Save and Copy carry the facts left ticked above the log", async () => {
  const { calls } = await openReport();
  fireEvent.click(screen.getByRole("checkbox", { name: /crates\/twigo-core/ }));
  click("Copy");
  const copied = (calls.find(([command]) => command === "clipboard")?.[1] ??
    "") as string;
  expect(copied.startsWith("Twigo: 0.1.0 (3f2a9c1)\nSystem: ")).toBe(true);
  expect(copied).toContain("Kubernetes: v1.33.4-eks-2d5f260, v1.37.2");
  expect(copied).not.toContain("Last panic:");
});
