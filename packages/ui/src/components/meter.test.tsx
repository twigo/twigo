import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { EmptyMeter, Meter } from "./meter";

afterEach(cleanup);

const fill = () =>
  screen.getByRole("meter").querySelector<HTMLElement>("span > span");

test("a meter says its figures to a screen reader and fills its share of the whole", () => {
  render(<Meter label="CPU of api" value={25} max={100} />);
  const meter = screen.getByRole("meter", { name: "CPU of api" });
  expect(meter.getAttribute("aria-valuenow")).toBe("25");
  expect(meter.getAttribute("aria-valuemax")).toBe("100");
  expect(fill()?.style.width).toBe("25%");
});

test("a value past the whole fills the bar and says no more than the whole", () => {
  render(<Meter label="CPU" value={140} max={100} tone="error" />);
  expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("100");
  expect(fill()?.style.width).toBe("100%");
  expect(fill()?.className).toContain("bg-error");
});

test("a mark stands at its place on the bar, and a warning has its own fill", () => {
  const { container } = render(
    <Meter label="Memory" value={30} max={200} mark={50} tone="warn" />,
  );
  expect(
    container.querySelector<HTMLElement>("[aria-hidden]")?.style.left,
  ).toBe("25%");
  expect(fill()?.className).toContain("bg-warn");
});

test("a meter reads its value as the words it is given, else as its numbers", () => {
  const { rerender } = render(
    <Meter label="CPU" value={25} max={100} valueText="25m of 100m limit" />,
  );
  expect(screen.getByRole("meter").getAttribute("aria-valuetext")).toBe(
    "25m of 100m limit",
  );
  rerender(<Meter label="CPU" value={25} max={100} />);
  expect(screen.getByRole("meter").hasAttribute("aria-valuetext")).toBe(false);
});

test("an empty meter has the size of a meter and says loading, with no figure", () => {
  const { container } = render(
    <>
      <Meter label="CPU" value={25} max={100} />
      <EmptyMeter label="CPU of api" />
    </>,
  );
  const empty = screen.getByRole("progressbar", { name: "CPU of api" });
  expect(empty.getAttribute("aria-valuetext")).toBe("Loading");
  expect(empty.hasAttribute("aria-valuenow")).toBe(false);
  expect(empty.className).toBe(screen.getByRole("meter").className);
  expect(empty.querySelectorAll("span > span")).toHaveLength(0);
  expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
});
