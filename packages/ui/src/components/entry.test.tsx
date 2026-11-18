import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Entry } from "./entry";

afterEach(() => {
  cleanup();
});

test("the title and the summary are one button that says both, and a click is its one action", () => {
  const onClick = vi.fn();
  render(
    <Entry title="Containers" summary="2 · 1 failing" onClick={onClick} />,
  );
  const entry = screen.getByRole("button", { name: /Containers/ });
  expect(entry.textContent).toBe("Containers2 · 1 failing");
  fireEvent.click(screen.getByText("2 · 1 failing"));
  expect(onClick).toHaveBeenCalledTimes(1);
});

test("an entry carries the tone it was given, and one without a tone has none", () => {
  render(
    <>
      <Entry title="Containers" tone="error" onClick={() => undefined} />
      <Entry title="Metadata" onClick={() => undefined} />
    </>,
  );
  const edge = (name: string) =>
    screen.getByRole("button", { name }).parentElement;
  expect(edge("Containers")?.getAttribute("data-tone")).toBe("error");
  expect(edge("Metadata")?.getAttribute("data-tone")).toBeNull();
});
