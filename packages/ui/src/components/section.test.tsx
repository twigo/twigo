import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Section } from "./section";

afterEach(() => {
  cleanup();
});

function shown(props: Partial<Parameters<typeof Section>[0]> = {}) {
  const onToggle = vi.fn();
  render(
    <Section
      title="Containers"
      open
      onToggle={onToggle}
      summary="2 · 1 failing"
      id="core.containers"
      {...props}
    >
      <p>the api container</p>
    </Section>,
  );
  return onToggle;
}

test("the title, the chevron and the summary are one toggle", () => {
  const onToggle = shown();
  const toggle = screen.getByRole("button", { name: /Containers/ });
  expect(toggle.textContent).toBe("Containers2 · 1 failing");
  fireEvent.click(screen.getByText("2 · 1 failing"));
  fireEvent.click(screen.getByText("Containers"));
  expect(onToggle).toHaveBeenCalledTimes(2);
});

test.each(["sm", "md"] as const)(
  "the chevron leads the title of a %s section",
  (size) => {
    shown({ size });
    const toggle = screen.getByRole("button", { name: /Containers/ });
    expect(toggle.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(toggle.firstElementChild?.nextElementSibling?.textContent).toBe(
      "Containers",
    );
  },
);

test("Alt tells the toggle to take every section of the page", () => {
  const onToggle = shown();
  const toggle = screen.getByRole("button", { name: /Containers/ });
  fireEvent.click(toggle);
  fireEvent.click(toggle, { altKey: true });
  expect(onToggle.mock.calls).toEqual([[false], [true]]);
});

test("a tone marks the header only, and a folded section is that header", () => {
  shown({ tone: "error", open: false });
  expect(screen.queryByText("the api container")).toBeNull();
  const marked = document.querySelector('[data-tone="error"]');
  expect(
    marked?.contains(screen.getByRole("button", { name: /Containers/ })),
  ).toBe(true);
  expect(marked?.textContent).toBe("Containers2 · 1 failing");
  cleanup();
  shown();
  expect(document.querySelector("[data-tone]")).toBeNull();
});

test("the section can be found by its id", () => {
  shown();
  expect(
    screen
      .getByRole("region", { name: "Containers" })
      .getAttribute("data-section"),
  ).toBe("core.containers");
});
