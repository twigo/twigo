import { act, cleanup, fireEvent, screen } from "@testing-library/react";
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
