import { act, render } from "@testing-library/react";
import type { Backend, CommandName, IpcError } from "@twigo/protocol";
import { createMockBackend, type MockScenario } from "@twigo/protocol/mock";
import { Toaster } from "@twigo/ui";
import { inWorkbench, testWorkbench } from "../testing";
import { ReportDialog } from "./ReportDialog";

/**
 * The report dialog open on the mock's report, with every command it sent and
 * every text it put on the clipboard, in the order they came.
 */
export async function openReport(
  refuse: Partial<Record<CommandName, IpcError>> = {},
  scenario: MockScenario = "ready",
) {
  const mock = createMockBackend(scenario);
  const calls: [string, unknown][] = [];
  const backend: Backend = {
    invoke: (command, request) => {
      calls.push([command, request]);
      const refusal = refuse[command];
      return refusal ? Promise.reject(refusal) : mock.invoke(command, request);
    },
    subscribe: (command, request, onMessage) =>
      mock.subscribe(command, request, onMessage),
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => {
        calls.push(["clipboard", text]);
        return Promise.resolve();
      },
    },
  });
  const workbench = await testWorkbench(scenario, backend);
  render(
    <>
      <ReportDialog />
      <Toaster />
    </>,
    { wrapper: inWorkbench(workbench) },
  );
  await act(() => workbench.problemReport.show());
  return { workbench, calls };
}
