import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { inWorkbench, testWorkbench } from "../testing";
import {
  SHOW_SHELL_ENVIRONMENT,
  ShellEnvironmentItem,
} from "./ShellEnvironmentItem";

afterEach(cleanup);

async function show(scenario: "ready" | "shellTimeout") {
  const workbench = await testWorkbench(scenario);
  await act(() => workbench.shellEnvironment.watch());
  render(<ShellEnvironmentItem />, { wrapper: inWorkbench(workbench) });
  return workbench;
}

test("a resolved environment shows nothing and offers no commands", async () => {
  const workbench = await show("ready");
  expect(document.body.textContent).toBe("");
  expect(
    workbench.commands.enabled(
      SHOW_SHELL_ENVIRONMENT,
      workbench.keys.lookup(null),
    ),
  ).toBe(false);
});

test("a timed-out environment explains itself, shows the shell's output and retries", async () => {
  await show("shellTimeout");
  fireEvent.click(
    screen.getByRole("button", { name: "Shell environment not loaded" }),
  );
  expect(document.body.textContent).toContain(
    "/bin/zsh did not answer in 10 s",
  );
  expect(screen.queryByText("Loading nvm…")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show details" }));
  expect(screen.getByText("Loading nvm…")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect((await screen.findByRole("status")).textContent).toBe(
    "Loading shell environment…",
  );
  expect(
    await screen.findByRole(
      "button",
      { name: "Shell environment not loaded" },
      { timeout: 3000 },
    ),
  ).toBeTruthy();
});

test("the command opens the same details", async () => {
  const workbench = await show("shellTimeout");
  await act(() =>
    workbench.commands.execute(
      SHOW_SHELL_ENVIRONMENT,
      workbench.keys.lookup(null),
    ),
  );
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});
