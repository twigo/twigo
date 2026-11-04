import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { StyledText } from "./StyledText";

afterEach(cleanup);

test("styled text splits at runs and marks, the current mark filled", () => {
  render(
    <p data-testid="text">
      <StyledText
        text="WARN db refused"
        runs={[
          {
            start: 0,
            end: 4,
            fg: "yellow",
            bg: null,
            bold: true,
            dim: false,
            italic: false,
            underline: false,
          },
        ]}
        marks={[{ start: 8, end: 15, current: true }]}
      />
    </p>,
  );
  const spans = [...screen.getByTestId("text").querySelectorAll("span")];
  expect(spans.map((span) => [span.textContent, span.className])).toEqual([
    ["WARN", "text-ansi-yellow font-semibold"],
    ["refused", "rounded-xs bg-mark-current text-mark-current-foreground"],
  ]);
  expect(screen.getByTestId("text").textContent).toBe("WARN db refused");
});

test("on a background, black and no colour are the theme's text", () => {
  render(
    <p data-testid="text">
      <StyledText
        text="FAIL"
        runs={[
          {
            start: 0,
            end: 4,
            fg: "black",
            bg: "yellow",
            bold: false,
            dim: false,
            italic: false,
            underline: false,
          },
        ]}
        marks={[]}
      />
    </p>,
  );
  expect(screen.getByText("FAIL").className).toBe(
    "text-foreground bg-ansi-yellow/25",
  );
});
