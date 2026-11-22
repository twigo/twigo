import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { EmptyState } from "./empty-state";

afterEach(cleanup);

test("what comes beside the action follows it", () => {
  render(
    <EmptyState
      title="Twigo hit an internal error"
      action={{ label: "Reopen", onClick: () => undefined }}
      secondary={<button type="button">Report…</button>}
    />,
  );
  const buttons = screen.getAllByRole("button").map((b) => b.textContent);
  expect(buttons).toEqual(["Reopen", "Report…"]);
});
