import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { notify } from "@twigo/ui";
import { StatusEntries } from "../parts/StatusBar";
import { inWorkbench, testWorkbench, toastWords } from "../testing";
import { useProblemEntries } from "./ProblemsEntry";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("problems:notice, the default: each problem raises one warning, in Rust's words, keyed by its code, with Reveal Log File and Report…", async () => {
  const warning = vi.spyOn(notify, "warning");
  const workbench = await testWorkbench("problems");
  await act(() => workbench.problems.watch());
  expect(warning).toHaveBeenCalledTimes(2);
  const [message, options] = warning.mock.calls[0] ?? [];
  expect(toastWords(message)).toContain("could not read its saved state");
  expect(options?.key).toBe("problem:state.set-aside");
  expect(options?.action?.label).toBe("Reveal Log File");
  expect(options?.more?.map(({ label }) => label)).toEqual(["Report…"]);
  expect(warning.mock.calls[1]?.[1]?.key).toBe("problem:audit.off");
});

test("problems:notice: the status bar counts nothing", async () => {
  const workbench = await testWorkbench("problems");
  render(<StatusEntries useEntries={useProblemEntries} />, {
    wrapper: inWorkbench(workbench),
  });
  await act(() => workbench.problems.watch());
  expect(screen.queryByText("2 problems")).toBeNull();
});

test("problems:notice: Report… opens the report and Reveal Log File shows the file", async () => {
  const warning = vi.spyOn(notify, "warning");
  const workbench = await testWorkbench("problems");
  const invoke = vi.spyOn(workbench.backend, "invoke");
  await act(() => workbench.problems.watch());
  const options = warning.mock.calls[0]?.[1];
  await act(async () => {
    options?.action?.run();
    options?.more?.[0]?.run();
    await Promise.resolve();
  });
  const sent = invoke.mock.calls.map(([command]) => command);
  expect(sent).toContain("log_reveal");
  expect(sent).toContain("report_problem");
});

test("a start with no problem raises none", async () => {
  const warning = vi.spyOn(notify, "warning");
  const workbench = await testWorkbench("live");
  await act(() => workbench.problems.watch());
  expect(warning).not.toHaveBeenCalled();
});
