import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { StatusDot } from "./status-dot";

afterEach(cleanup);

const dot = () => document.querySelector(".rounded-full")?.className ?? "";

test("an idle dot is filled grey, and a hollow one is the same grey as a ring", () => {
  render(<StatusDot tone="idle" />);
  expect(dot()).toContain("bg-muted-foreground-2");
  cleanup();
  render(<StatusDot tone="idle" hollow />);
  expect(dot()).toContain("inset_0_0_0_1.5px_var(--muted-foreground-2)");
  expect(dot()).not.toContain("bg-muted-foreground-2");
});

test("hollow means an idle state that is off, so it changes no other tone's shape", () => {
  render(<StatusDot tone="error" hollow />);
  expect(dot()).toContain("bg-error");
  cleanup();
  render(<StatusDot tone="warn" hollow />);
  expect(dot()).toContain("var(--warn)");
});

test("a dot says nothing to a screen reader unless it has a label", () => {
  const { container } = render(<StatusDot tone="idle" hollow />);
  expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  cleanup();
  const labelled = render(<StatusDot tone="idle" hollow label="Stopped" />);
  expect(labelled.getByRole("img", { name: "Stopped" })).toBeTruthy();
});
