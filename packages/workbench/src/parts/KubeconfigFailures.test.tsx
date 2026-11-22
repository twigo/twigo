import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { testWorkbench } from "../testing";
import { WorkbenchView } from "../WorkbenchView";

afterEach(cleanup);

test("when every kubeconfig file failed the start says so and names the files with their words", async () => {
  const workbench = await testWorkbench("kubeconfigAllFailed");
  render(<WorkbenchView workbench={workbench} />);
  await act(() => Promise.resolve());
  const start = screen.getByText(
    "None of the 2 kubeconfig files could be read",
  ).parentElement;
  if (!start) throw new Error("no start");
  const files = within(start);
  expect(files.getByText("~/.kube/broken.yaml")).toBeTruthy();
  expect(
    files.getByText(
      "The file cannot be parsed: expected sequence start at line 7, column 10",
      { exact: false },
    ),
  ).toBeTruthy();
  expect(files.getByText("kubeconfig.unparsable")).toBeTruthy();
  expect(files.getByText("~/.kube/work/locked.yaml")).toBeTruthy();
  expect(screen.queryByText("Go to resource")).toBeNull();
});
