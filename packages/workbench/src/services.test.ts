import { act } from "@testing-library/react";
import type {
  ApprovalAsk,
  ApprovalEvent,
  Backend,
  KeyboardLayout,
} from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { expect, test } from "vitest";
import { createWorkbench, type Workbench } from "./services";

const US: KeyboardLayout = { id: "us", keys: {} };
const DVORAK: KeyboardLayout = {
  id: "dvorak",
  keys: {
    KeyN: { value: "b", withShift: "B", withAltGr: "", withShiftAltGr: "" },
  },
};

function layoutBackend(early: KeyboardLayout) {
  const mock = createMockBackend("ready");
  let send: (layout: KeyboardLayout) => void = () => undefined;
  const backend: Backend = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe(command, request, onMessage) {
      if (command !== "keyboard_layout_watch") {
        return mock.subscribe(command, request, onMessage);
      }
      send = onMessage;
      send(early);
      return Promise.resolve(US);
    },
  };
  return { backend, send: (layout: KeyboardLayout) => send(layout) };
}

const sidebarKey = (workbench: Workbench) =>
  workbench.keybindings.primary("workbench.action.toggleSidebarVisibility")
    ?.presses[0].code;

test("a layout sent before the watch answers wins over its answer, and later ones follow", async () => {
  const { backend, send } = layoutBackend(DVORAK);
  const workbench = await act(() => createWorkbench(backend, "mac"));
  expect(sidebarKey(workbench)).toBe("KeyN");
  send(US);
  expect(sidebarKey(workbench)).toBe("KeyB");
});

test("the window follows the approval broker from startup", async () => {
  const mock = createMockBackend("ready");
  let send: (event: ApprovalEvent) => void = () => undefined;
  const backend: Backend = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe(command, request, onMessage) {
      if (command !== "approvals_watch") {
        return mock.subscribe(command, request, onMessage);
      }
      send = onMessage;
      return Promise.resolve(null);
    },
  };
  const ask: ApprovalAsk = {
    id: 1,
    context: "staging",
    process: "Terminal 1",
    command: null,
    verb: "patch",
    class: "write",
    target: "deployments/web in default",
    impersonate: null,
    detail: { kind: "delete", propagation: null },
    typed: false,
    lastingMinutes: 15,
  };
  const workbench = await act(() => createWorkbench(backend, "mac"));
  send({ event: "asked", ask });
  expect(workbench.approvals.asks).toEqual([ask]);
});
