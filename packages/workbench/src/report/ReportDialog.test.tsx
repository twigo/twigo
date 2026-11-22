import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { IpcError } from "@twigo/protocol";
import { carriesCode } from "../testing";
import { openReport } from "./testing";
import { SECURITY_URL } from "./words";

afterEach(() => {
  cleanup();
});

const click = (name: string | RegExp) => {
  fireEvent.click(screen.getByRole("button", { name }));
};

test("the dialog says the issue is public and that nothing leaves before a button, and links private reporting for a security problem", async () => {
  const { calls } = await openReport();
  const words = screen.getByRole("dialog").textContent;
  expect(words).toContain("which anyone can read");
  expect(words).toContain("Nothing leaves this computer until you choose");
  expect(words).toContain("Twigo itself sends nothing");
  expect(
    calls.filter(([command]) => command.startsWith("report_")),
  ).toHaveLength(1);
  click("Report it privately.");
  expect(calls).toContainEqual(["url_open", SECURITY_URL]);
});

test("Reveal Log File shows the file, and Cancel closes the dialog without sending anything", async () => {
  const { calls } = await openReport();
  click("Reveal Log File");
  await act(() => Promise.resolve());
  expect(calls).toContainEqual(["log_reveal", null]);
  click("Cancel");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    calls.filter(([command]) => command.startsWith("report_")),
  ).toHaveLength(1);
});

test("Open Issue puts the log as the person sees it on the clipboard before it asks Rust, then closes and says where to paste it", async () => {
  const { calls } = await openReport();
  const field = screen.getByRole("textbox", { name: /^(Log|Report)$/ });
  fireEvent.change(field, {
    target: { value: `${(field as HTMLTextAreaElement).value}\nand my note` },
  });
  click("Open Issue on GitHub");
  await screen.findByText(/paste it into Logs/);
  const order = calls.map(([command]) => command);
  expect(order.indexOf("clipboard")).toBeGreaterThan(-1);
  expect(order.indexOf("clipboard")).toBeLessThan(
    order.indexOf("report_open_issue"),
  );
  const [, written] = calls.find(([command]) => command === "clipboard") ?? [];
  expect(written).toContain("and my note");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("an Open Issue that fails keeps the dialog and shows the error with its code", async () => {
  await openReport({
    report_open_issue: new IpcError("link.open-failed", "no browser answers"),
  });
  click("Open Issue on GitHub");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("no browser answers");
  expect(carriesCode(alert, "link.open-failed")).toBe(true);
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("a clipboard that refuses stops Open Issue before it opens anything, and says so", async () => {
  const { calls } = await openReport();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: () => Promise.reject(new Error("not allowed")) },
  });
  click("Open Issue on GitHub");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("not allowed");
  expect(calls.map(([command]) => command)).not.toContain("report_open_issue");
});

test("Save sends Rust the text that Copy puts on the clipboard, and says where it was saved", async () => {
  const { calls } = await openReport();
  click("Copy");
  await act(() => Promise.resolve());
  click("Save…");
  await screen.findByText(/^Saved to /);
  const copied = calls.find(([command]) => command === "clipboard")?.[1];
  const saved = calls.find(([command]) => command === "report_save")?.[1];
  expect(saved).toEqual({ text: copied });
  expect(copied).toContain("Twigo: 0.1.0");
});

test("a Save that fails shows its error as the others do", async () => {
  await openReport({
    report_save: new IpcError("file.unwritten", "the disk is full"),
  });
  click("Save…");
  const alert = await screen.findByRole("alert");
  expect(carriesCode(alert, "file.unwritten")).toBe(true);
});

test("the facts are read-only and only the optional ones have a tick, and the log is its own field", async () => {
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

test("Open Issue states the facts left ticked and no more, and copies the log alone", async () => {
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

test("Save and Copy carry the facts left ticked above the log", async () => {
  const { calls } = await openReport();
  fireEvent.click(screen.getByRole("checkbox", { name: /crates\/twigo-core/ }));
  click("Copy");
  const copied = (calls.find(([command]) => command === "clipboard")?.[1] ??
    "") as string;
  expect(copied.startsWith("Twigo: 0.1.0 (3f2a9c1)\nSystem: ")).toBe(true);
  expect(copied).toContain("Kubernetes: v1.33.4-eks-2d5f260, v1.37.2");
  expect(copied).not.toContain("Last panic:");
});
