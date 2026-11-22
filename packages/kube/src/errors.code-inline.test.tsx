import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ViewState } from "@twigo/protocol";
import { ViewStatus } from "./ViewStatus";
import { ending } from "./xterm/words";

beforeEach(() => {
  history.replaceState(null, "", "/?variant=code:inline");
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

test("code:inline: an empty state and a session's ending lead with the code, and nothing is left to copy", () => {
  const { container } = render(<ViewStatus status={REFUSED} what="pods" />);
  expect(container.querySelector("p.max-w-md")?.textContent).toBe(
    "server.invalid: Pod web is invalid",
  );
  expect(screen.queryByRole("button", { name: "Copy details" })).toBeNull();

  const { title, detail } = ending({
    reason: "failed",
    error: { code: "server.forbidden", kind: "forbidden", message: "no exec" },
  });
  expect([title, detail]).toEqual(["server.forbidden: no exec", undefined]);
});
