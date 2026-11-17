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
    <CutInTheMiddle text="payments-api-production" floor={16} separator="-" />,
  );
  expect(parts(container)).toEqual(["paymen", "ts-api-", "production"]);
  expect(container.textContent).toBe("payments-api-production");
});

test("a text within its floor is one piece", () => {
  const { container } = render(
    <CutInTheMiddle text="payments" floor={16} separator="-" />,
  );
  expect(parts(container)).toEqual([]);
  expect(container.textContent).toBe("payments");
});
