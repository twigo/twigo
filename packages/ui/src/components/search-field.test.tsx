import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { SearchField } from "./search-field";

afterEach(cleanup);

function Filter({ text }: { text: string }) {
  const [value, setValue] = useState(text);
  return (
    <SearchField label="Filter" value={value} onChange={setValue} keys="/" />
  );
}

const field = () =>
  screen.getByRole<HTMLInputElement>("textbox", {
    name: "Filter",
  });

test("Escape clears the text first, then leaves the field", () => {
  render(<Filter text="api" />);
  field().focus();
  fireEvent.keyDown(field(), { key: "Escape" });
  expect(field().value).toBe("");
  expect(document.activeElement).toBe(field());
  fireEvent.keyDown(field(), { key: "Escape" });
  expect(document.activeElement).not.toBe(field());
});

test("with text a button clears it, and without it the field shows the key that focuses it", () => {
  render(<Filter text="api" />);
  expect(screen.queryByText("/")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  expect(field().value).toBe("");
  expect(screen.queryByRole("button", { name: "Clear filter" })).toBeNull();
  expect(screen.getByText("/")).toBeTruthy();
});
