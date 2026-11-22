import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notify } from "@twigo/ui";
import { testWorkbench } from "./testing";

beforeEach(() => {
  history.replaceState(null, "", "/?variant=toast:none");
});

afterEach(() => {
  history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

test("toast:none raises no toast for a file that fails, which the picker and the start still say", async () => {
  const warning = vi.spyOn(notify, "warning");
  const workbench = await testWorkbench("kubeconfigFailures");
  expect(workbench.catalog.failures).toHaveLength(2);
  expect(warning).not.toHaveBeenCalled();
});
