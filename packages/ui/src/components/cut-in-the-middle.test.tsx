import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { CutInTheMiddle } from "./cut-in-the-middle";

afterEach(cleanup);

const parts = (container: HTMLElement) =>
  [...(container.firstElementChild?.children ?? [])].map(
    (part) => part.textContent,
  );

test("a text past its floor is three parts, the head and the tail whole and the middle between them, which CSS cuts", () => {
  const { container } = render(
    <CutInTheMiddle
      text="payments-api-production-checkout"
      floor={16}
      separator="-"
    />,
  );
  expect(parts(container)).toEqual([
    "payments",
    "-api-production-",
    "checkout",
  ]);
  expect(container.textContent).toBe("payments-api-production-checkout");
});

test("a text within its floor is one piece", () => {
  const { container } = render(
    <CutInTheMiddle text="payments" floor={16} separator="-" />,
  );
  expect(parts(container)).toEqual([]);
  expect(container.textContent).toBe("payments");
});

test("a text whose middle measures 2em or less is one piece, so the track leaves no gap, and one a character more is cut", () => {
  const whole = render(
    <CutInTheMiddle
      text="kubernetes12ilitcontrolplane"
      floor={24}
      separator="-"
    />,
  );
  expect(parts(whole.container)).toEqual([]);
  expect(whole.container.textContent).toBe("kubernetes12ilitcontrolplane");
  const cut = render(
    <CutInTheMiddle
      text="kubernetes12ilitscontrolplane"
      floor={24}
      separator="-"
    />,
  );
  expect(parts(cut.container)).toEqual([
    "kubernetes12",
    "ilits",
    "controlplane",
  ]);
});

test("the middle is measured in the font of the element, so the same text takes fewer em at a larger size", () => {
  const text = "kubernetes12ilitscontrolplane";
  const small = render(
    <div style={{ fontSize: "16px" }}>
      <CutInTheMiddle text={text} floor={24} separator="-" />
    </div>,
  );
  const large = render(
    <div style={{ fontSize: "40px" }}>
      <CutInTheMiddle text={text} floor={24} separator="-" />
    </div>,
  );
  const middleOf = (container: HTMLElement) =>
    [...(container.firstElementChild?.firstElementChild?.children ?? [])].map(
      (part) => part.textContent,
    );
  expect(middleOf(small.container)).toHaveLength(3);
  expect(middleOf(large.container)).toEqual([]);
});

test("an element outside the document is not measured, so a text there is whole and never cut with a gap", () => {
  const container = document.createElement("div");
  const { container: out } = render(
    <CutInTheMiddle
      text="payments-api-production-checkout"
      floor={16}
      separator="-"
    />,
    { container },
  );
  expect(parts(out)).toEqual([]);
  expect(out.textContent).toBe("payments-api-production-checkout");
});

test("a text that could be cut says so until its font is read, and a text within its floor never does", () => {
  const out = document.createElement("div");
  const pending = (container: HTMLElement) =>
    container.querySelector("[data-cut-pending]") !== null;
  render(
    <CutInTheMiddle
      text="payments-api-production-checkout"
      floor={16}
      separator="-"
    />,
    { container: out },
  );
  expect(pending(out)).toBe(true);
  const read = render(
    <CutInTheMiddle
      text="payments-api-production-checkout"
      floor={16}
      separator="-"
    />,
  );
  expect(pending(read.container)).toBe(false);
  const short = render(
    <CutInTheMiddle text="payments" floor={16} separator="-" />,
    { container: document.createElement("div") },
  );
  expect(pending(short.container)).toBe(false);
});

test("a text that a neighbour says whole can be hidden from assistive technology", () => {
  const { container } = render(
    <CutInTheMiddle
      text="payments-api-production-checkout"
      floor={16}
      separator="-"
      aria-hidden
    />,
  );
  expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
});
