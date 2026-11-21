import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ErrorDetails } from "./error-details";

afterEach(cleanup);

function clipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

test("Copy details puts what it was given on the clipboard and says so", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  clipboard(writeText);
  render(<ErrorDetails code="connect.refused" copy="Code: connect.refused" />);
  expect(screen.getByText("connect.refused")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
  expect(writeText).toHaveBeenCalledWith("Code: connect.refused");
  await screen.findByRole("button", { name: "Copied" });
});

test("a clipboard that refuses says it could not copy", async () => {
  clipboard(() => Promise.reject(new Error("denied")));
  render(<ErrorDetails copy="x" />);
  fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
  await screen.findByRole("button", { name: "Could not copy" });
});

test("the code and the button are each optional, and neither draws nothing", () => {
  const { container, rerender } = render(<ErrorDetails code="a.b" />);
  expect(screen.queryByRole("button")).toBeNull();
  rerender(<ErrorDetails copy="x" />);
  expect(screen.getByRole("button", { name: "Copy details" })).toBeTruthy();
  expect(container.querySelector("code")).toBeNull();
  rerender(<ErrorDetails />);
  expect(container.innerHTML).toBe("");
});
