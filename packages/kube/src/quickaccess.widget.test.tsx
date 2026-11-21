import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { mountKube, settle, withScreenSize } from "../test/workbench";

withScreenSize();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const key = (code: string, init: KeyboardEventInit = {}) => {
  fireEvent.keyDown(screen.getByRole("combobox"), {
    key: code === "Space" ? " " : code,
    code,
    ...init,
  });
};

test("a person who may not list namespaces types names and adds each with Space, the typed one under the cursor, and Enter applies them with the current ones", async () => {
  const workbench = await mountKube(createMockBackend("rbacTypedNamespaces"));
  workbench.spaces.update("prod-eu", (state) => ({
    ...state,
    namespaces: ["default"],
  }));
  act(() => {
    workbench.quickAccess.show("ns ");
  });
  await settle();
  for (const name of ["team-b", "payments"]) {
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: `ns ${name}` },
    });
    await settle();
    key("Space");
  }
  await settle();
  key("Enter");
  await settle();
  expect(workbench.spaces.state("prod-eu").namespaces).toEqual([
    "default",
    "payments",
    "team-b",
  ]);
  expect(workbench.quickAccess.session).toBeUndefined();
});

test("Enter on the typed name alone takes it as the only namespace", async () => {
  const workbench = await mountKube(createMockBackend("rbacTypedNamespaces"));
  act(() => {
    workbench.quickAccess.show("ns ");
  });
  await settle();
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "ns team-b" },
  });
  await settle();
  key("Enter");
  await settle();
  expect(workbench.spaces.state("prod-eu").namespaces).toEqual(["team-b"]);
});

test.each([
  ["c", "checkout"],
  ["pa", "payments"],
])(
  "ns %s then Enter takes %s, though All namespaces matches the text too",
  async (typed, name) => {
    const workbench = await mountKube();
    act(() => {
      workbench.quickAccess.show("ns ");
    });
    await settle();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: `ns ${typed}` },
    });
    await settle();
    key("Enter");
    await settle();
    expect(workbench.spaces.state("prod-eu").namespaces).toEqual([name]);
  },
);

test("a person who may not list namespaces ticks the name typed with Space, though All namespaces matches the text too", async () => {
  const workbench = await mountKube(createMockBackend("rbacTypedNamespaces"));
  act(() => {
    workbench.quickAccess.show("ns ");
  });
  await settle();
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "ns space" },
  });
  await settle();
  key("Space");
  key("Enter");
  await settle();
  expect(workbench.spaces.state("prod-eu").namespaces).toEqual(["space"]);
});
