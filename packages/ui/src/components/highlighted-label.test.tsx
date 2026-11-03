import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { HighlightedLabel } from "./highlighted-label";

afterEach(cleanup);

function drawn(text: string, ranges: { start: number; end: number }[]) {
  const { container } = render(
    <HighlightedLabel text={text} ranges={ranges} />,
  );
  return [...(container.firstElementChild?.childNodes ?? [])]
    .map((node) =>
      node.nodeName === "MARK"
        ? `[${node.textContent ?? ""}]`
        : node.textContent,
    )
    .join("");
}

test("the matched runs are marked and the text between and after them stays plain", () => {
  expect(
    drawn("api-gateway", [
      { start: 0, end: 3 },
      { start: 8, end: 9 },
    ]),
  ).toBe("[api]-gate[w]ay");
  expect(drawn("api-gateway", [{ start: 4, end: 11 }])).toBe("api-[gateway]");
  expect(drawn("pods", [])).toBe("pods");
});
