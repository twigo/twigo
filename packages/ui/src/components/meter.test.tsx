import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Meter } from "./meter";

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
