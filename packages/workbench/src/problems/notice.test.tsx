import { act, cleanup } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { IpcError, type Backend } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { notify } from "@twigo/ui";
import { testWorkbench, toastWords } from "../testing";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("each problem raises one warning, in Rust's words, keyed by its code, with Reveal Log File and Report…", async () => {
  const warning = vi.spyOn(notify, "warning");
  const workbench = await testWorkbench("problems");
  await act(() => workbench.problems.watch());
  expect(warning).toHaveBeenCalledTimes(2);
  const [message, options] = warning.mock.calls[0] ?? [];
  expect(toastWords(message)).toContain("could not read its saved state");
  expect(options?.key).toBe("problem:state.set-aside");
  expect(warning.mock.calls[1]?.[1]?.key).toBe("problem:audit.off");
  for (const [, offered] of warning.mock.calls) {
    expect(offered?.action?.label).toBe("Reveal Log File");
    expect(offered?.more?.map(({ label }) => label)).toEqual(["Report…"]);
  }
});

test("the problem of a protection file that cannot be read offers Start Over…, which plans one, with Reveal Log File and Report… under more", async () => {
  const warning = vi.spyOn(notify, "warning");
  const workbench = await testWorkbench("protectionUnreadable");
  const invoke = vi.spyOn(workbench.backend, "invoke");
  await act(() => workbench.problems.watch());
  expect(warning).toHaveBeenCalledTimes(1);
  const options = warning.mock.calls[0]?.[1];
  expect(options?.key).toBe("problem:protection.unreadable");
  expect(options?.action?.label).toBe("Start Over…");
  expect(options?.more?.map(({ label }) => label)).toEqual([
    "Reveal Log File",
    "Report…",
  ]);
  await act(async () => {
    options?.action?.run();
    await Promise.resolve();
  });
  expect(invoke).toHaveBeenCalledWith("command_plan", { action: "startOver" });
});

test("Report… opens the report and Reveal Log File shows the file", async () => {
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

test("a problem that Rust clears takes its notice away, and raises it again when it returns", async () => {
  const mock = createMockBackend("problems");
  let send: ((next: IpcError[]) => void) | undefined;
  const backend: Backend = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe: (command, request, onMessage) => {
      if (command === "problems_watch") {
        send = onMessage;
      }
      return mock.subscribe(command, request, onMessage);
    },
  };
  const warning = vi.spyOn(notify, "warning");
  const dismiss = vi.spyOn(notify, "dismiss");
  const workbench = await testWorkbench("problems", backend);
  await act(() => workbench.problems.watch());
  expect(warning).toHaveBeenCalledTimes(2);
  const setAside = new IpcError("state.set-aside", "set aside");
  const auditOff = new IpcError("audit.off", "off");

  act(() => {
    send?.([auditOff]);
  });
  expect(dismiss.mock.calls).toEqual([["problem:state.set-aside"]]);

  act(() => {
    send?.([auditOff, setAside]);
  });
  expect(warning).toHaveBeenCalledTimes(3);
  expect(warning.mock.calls[2]?.[1]?.key).toBe("problem:state.set-aside");
});

test("a start with no problem raises none", async () => {
  const warning = vi.spyOn(notify, "warning");
  const workbench = await testWorkbench("live");
  await act(() => workbench.problems.watch());
  expect(warning).not.toHaveBeenCalled();
});
