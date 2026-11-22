import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notify } from "@twigo/ui";
import { StatusEntries } from "../parts/StatusBar";
import { inWorkbench, testWorkbench } from "../testing";
import { useProblemEntries } from "./ProblemsEntry";

beforeEach(() => {
  history.replaceState(null, "", "/?variant=problems:status");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

test("problems:status raises nothing, and the status bar counts the problems and opens them with the two ways to look further", async () => {
  const warning = vi.spyOn(notify, "warning");
  const workbench = await testWorkbench("problems");
  render(<StatusEntries useEntries={useProblemEntries} />, {
    wrapper: inWorkbench(workbench),
  });
  expect(screen.queryByText("2 problems")).toBeNull();
  await act(() => workbench.problems.watch());
  expect(warning).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: /^What Twigo could not do/ }),
  );
  expect(screen.getByText("2 problems")).toBeTruthy();
  expect(document.body.textContent).toContain("could not read its saved state");
  expect(document.body.textContent).toContain("state.set-aside");
  fireEvent.click(screen.getByRole("button", { name: "Report…" }));
  await act(() => Promise.resolve());
  expect(workbench.problemReport.report).toBeDefined();
});
