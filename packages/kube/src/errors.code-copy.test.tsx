import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ViewState } from "@twigo/protocol";
import { ViewStatus } from "./ViewStatus";
import { ending } from "./xterm/words";

beforeEach(() => {
  history.replaceState(null, "", "/?variant=code:copy");
});

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
});

const REFUSED: ViewState = {
  state: "error",
  error: {
    code: "server.invalid",
    kind: "invalidInput",
    message: "Pod web is invalid",
  },
};

test("code:copy: an empty state shows no code and only Copy details, and a session's ending says the message alone", () => {
  const { container } = render(<ViewStatus status={REFUSED} what="pods" />);
  expect(container.textContent).not.toContain("server.invalid");
  expect(screen.getByRole("button", { name: "Copy details" })).toBeTruthy();

  const { title, detail } = ending({
    reason: "failed",
    error: { code: "server.forbidden", kind: "forbidden", message: "no exec" },
  });
  expect([title, detail]).toEqual(["no exec", undefined]);
});
