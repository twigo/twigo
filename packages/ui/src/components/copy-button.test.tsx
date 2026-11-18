import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CopyButton } from "./copy-button";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function clipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

test("a click puts the text on the clipboard and the button says so for a moment", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  clipboard(writeText);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<CopyButton text="registry.k8s.io/pause:3.10" label="Copy image" />);
  fireEvent.click(screen.getByRole("button", { name: "Copy image" }));
  expect(writeText).toHaveBeenCalledWith("registry.k8s.io/pause:3.10");
  await screen.findByRole("button", { name: "Copied" });
  await act(() => vi.advanceTimersByTimeAsync(1600));
  expect(screen.getByRole("button", { name: "Copy image" })).toBeTruthy();
});

test("a clipboard that refuses says it could not copy", async () => {
  clipboard(() => Promise.reject(new Error("denied")));
  render(<CopyButton text="x" label="Copy image" />);
  fireEvent.click(screen.getByRole("button", { name: "Copy image" }));
  await screen.findByRole("button", { name: "Could not copy" });
});
