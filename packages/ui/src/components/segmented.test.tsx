import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Segmented, type SegmentedItem } from "./segmented";

afterEach(cleanup);

type Health = "all" | "failing" | "pending" | "healthy";

const ITEMS: readonly SegmentedItem<Health>[] = [
  { value: "all", label: "All", count: 12 },
  { value: "failing", label: "Failing", count: 2, tone: "error" },
  { value: "pending", label: "Pending", count: 3, tone: "warn" },
  { value: "healthy", label: "Healthy", count: 10, tone: "ok" },
];

function health(value: Health = "all", items = ITEMS) {
  const onChange = vi.fn();
  render(
    <Segmented
      label="Health"
      items={items}
      value={value}
      onChange={onChange}
    />,
  );
  return onChange;
}

const item = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) });

test("one bordered group, the picked item pressed, and a click picks another", () => {
  const onChange = health("failing");
  expect(screen.getByRole("group", { name: "Health" })).toBeTruthy();
  expect(
    screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-pressed")),
  ).toEqual(["false", "true", "false", "false"]);
  fireEvent.click(item("Healthy"));
  expect(onChange).toHaveBeenCalledWith("healthy");
});

test("an abnormal tone puts a dot before the label, and an error count above 0 takes its colour", () => {
  health();
  const dot = (name: string) =>
    item(name).querySelector('[aria-hidden="true"]');
  expect(dot("All")).toBeNull();
  expect(dot("Healthy")).toBeNull();
  expect(dot("Failing")).toHaveClass("bg-error");
  expect(dot("Pending")).not.toBeNull();
  expect(screen.getByText("2")).toHaveClass("text-error");
  expect(screen.getByText("3")).not.toHaveClass("text-error");
  expect(screen.getByText("10")).not.toHaveClass("text-error");
  cleanup();
  health("all", [
    { value: "failing", label: "Failing", count: 0, tone: "error" },
  ]);
  expect(screen.getByText("0")).not.toHaveClass("text-error");
});
