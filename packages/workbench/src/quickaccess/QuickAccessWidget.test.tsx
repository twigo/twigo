import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Box } from "lucide-react";
import { afterEach, expect, test, vi } from "vitest";
import { inWorkbench, testWorkbench } from "../testing";
import type { Workbench } from "../services";
import { QuickAccessWidget } from "./QuickAccessWidget";
import type { QuickAccessProvider, QuickPickItem } from "./registry";

afterEach(cleanup);

function provider(
  prefix: string,
  items: readonly QuickPickItem[],
  extra: Partial<QuickAccessProvider> = {},
) {
  const accept = vi.fn();
  const registered: QuickAccessProvider = {
    prefix,
    placeholder: "",
    help: "",
    items: () => items,
    accept,
    ...extra,
  };
  return { registered, accept };
}

async function opened(workbench: Workbench, value: string) {
  render(<QuickAccessWidget />, { wrapper: inWorkbench(workbench) });
  await act(async () => {
    workbench.quickAccess.show(value);
    await Promise.resolve();
  });
}

const input = () => screen.getByRole("combobox");
const press = (code: string, init: KeyboardEventInit = {}) => {
  fireEvent.keyDown(input(), { key: code.replace(/^Key/, ""), code, ...init });
};
const selected = () =>
  document.querySelector('[cmdk-item][aria-selected="true"]')?.textContent;
const footer = () => screen.getByLabelText("Keys").textContent;

test("items loaded for another value are neither shown nor accepted", async () => {
  const workbench = await testWorkbench();
  const pending = new Map<string, (items: QuickPickItem[]) => void>();
  const accept = vi.fn();
  workbench.quickAccess.register({
    prefix: "!",
    placeholder: "",
    help: "",
    items: (filter) =>
      new Promise((resolve) => {
        pending.set(filter, resolve);
      }),
    accept,
  });
  render(<QuickAccessWidget />, { wrapper: inWorkbench(workbench) });
  act(() => {
    workbench.quickAccess.show("!a");
  });
  await act(async () => {
    pending.get("a")?.([{ id: "a", label: "alpha" }]);
    await Promise.resolve();
  });
  expect(screen.getByText("alpha")).toBeTruthy();

  fireEvent.change(input(), { target: { value: "!ab" } });
  expect(screen.queryByText("alpha")).toBeNull();
  press("Enter");
  expect(accept).not.toHaveBeenCalled();

  await act(async () => {
    pending.get("ab")?.([{ id: "ab", label: "alphabet" }]);
    await Promise.resolve();
  });
  expect(screen.getByText("alphabet")).toBeTruthy();
});

test("a row draws what its provider says: icon or tile, matches, description, state, kind and keys", async () => {
  const workbench = await testWorkbench();
  const { registered } = provider("!", [
    {
      id: "pod",
      label: "auth-api-7f9",
      matches: [{ start: 0, end: 4 }],
      description: "payments",
      icon: Box,
      state: { tone: "error", label: "CrashLoopBackOff" },
      kind: "Pod",
      group: "Pods",
    },
    {
      id: "space",
      label: "prod-eu",
      tile: { name: "prod-eu", color: "red" },
      keybinding: "⌘1",
      group: "Open spaces",
    },
  ]);
  workbench.quickAccess.register(registered);
  await opened(workbench, "!");

  const pod = screen.getByRole("option", { name: /auth-api-7f9/ });
  expect(pod.querySelector("svg")).not.toBeNull();
  expect(
    [...pod.querySelectorAll("mark")].map((mark) => mark.textContent),
  ).toEqual(["auth"]);
  expect(screen.getByText("payments")).toBeTruthy();
  expect(
    screen.getByText("CrashLoopBackOff").parentElement?.className,
  ).toContain("text-error");
  expect(screen.getByText("Pod")).toBeTruthy();
  const space = screen.getByRole("option", { name: /prod-eu/ });
  expect(space.textContent).toBe("PEprod-eu⌘1");
  expect(screen.getByText("Pods")).toBeTruthy();
  expect(screen.getByText("Open spaces")).toBeTruthy();
});

test("↓ and ↑ move through the rows and wrap, Enter accepts, all by their bindings", async () => {
  const workbench = await testWorkbench();
  const { registered, accept } = provider("!", [
    { id: "a", label: "alpha", group: "One" },
    { id: "b", label: "beta", group: "Two" },
    { id: "c", label: "gamma", group: "One" },
  ]);
  workbench.quickAccess.register(registered);
  await opened(workbench, "!");
  expect(selected()).toBe("alpha");
  press("ArrowDown");
  expect(selected()).toBe("gamma");
  press("ArrowDown");
  expect(selected()).toBe("beta");
  press("ArrowDown");
  expect(selected()).toBe("alpha");
  press("ArrowUp");
  expect(selected()).toBe("beta");
  press("Enter");
  await act(() => Promise.resolve());
  expect(accept).toHaveBeenCalledWith(
    expect.objectContaining({ id: "b" }),
    "",
    expect.anything(),
    { side: false },
  );
  expect(workbench.quickAccess.session).toBeUndefined();
});

test("a key the user binds instead moves, and the unbound one does not", async () => {
  const workbench = await testWorkbench();
  workbench.keybindings.register("user", [
    { command: "-quickInput.next" },
    { key: "ctrl+j", command: "quickInput.next", when: "inQuickOpen" },
  ]);
  const { registered } = provider("!", [
    { id: "a", label: "alpha" },
    { id: "b", label: "beta" },
  ]);
  workbench.quickAccess.register(registered);
  await opened(workbench, "!");
  press("ArrowDown");
  expect(selected()).toBe("alpha");
  press("KeyJ", { ctrlKey: true });
  expect(selected()).toBe("beta");
  expect(footer()).toContain("↑⌃JMove");
});

test("⌘↵ opens to the side only where the provider can", async () => {
  const workbench = await testWorkbench();
  const side = provider("", [{ id: "a", label: "alpha" }], { toSide: true });
  const plain = provider("!", [{ id: "b", label: "beta" }]);
  workbench.quickAccess.register(side.registered);
  workbench.quickAccess.register(plain.registered);

  await opened(workbench, "!");
  press("Enter", { metaKey: true });
  await act(() => Promise.resolve());
  expect(plain.accept).not.toHaveBeenCalled();
  expect(footer()).not.toContain("Open to the side");

  act(() => {
    workbench.quickAccess.show("");
  });
  await act(() => Promise.resolve());
  expect(footer()).toContain("⌘↩Open to the side");
  press("Enter", { metaKey: true });
  await act(() => Promise.resolve());
  expect(side.accept).toHaveBeenCalledWith(
    expect.objectContaining({ id: "a" }),
    "",
    expect.anything(),
    { side: true },
  );
});

test("the footer shows the keys from the registry and, on no prefix, the prefixes providers name", async () => {
  const workbench = await testWorkbench();
  workbench.quickAccess.register(provider("", []).registered);
  workbench.quickAccess.register(
    provider("!", [], { hint: "Bangs", acceptLabel: "Bang" }).registered,
  );
  await opened(workbench, "");
  expect(footer()).toBe("↑↓Move↩Open>Commands?Help!Bangs");

  act(() => {
    workbench.quickAccess.show("!");
  });
  expect(footer()).toBe("↑↓Move↩Bang");
  act(() => {
    workbench.quickAccess.show(">");
  });
  expect(footer()).toBe("↑↓Move↩Run");
});
