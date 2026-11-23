import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { mountKube, settle, withScreenSize } from "../../test/workbench";
import { helmUri } from "../uri";

vi.mock("./MaskedText", () => ({
  default: () => <div data-testid="masked-text" />,
}));

withScreenSize(1280);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  window.history.replaceState({}, "", "/");
});

const variant = (name: string) => {
  window.history.replaceState({}, "", `/?variant=${name}`);
};

const alpha = helmUri({
  space: "prod-eu",
  namespace: "payments",
  name: "alpha",
});

async function open(uri: string) {
  const workbench = await mountKube(createMockBackend("ready"));
  act(() => {
    workbench.editors.open(uri);
  });
  await settle(8);
  return workbench;
}

test("mask:tree shows the values as rows of key paths in a tree that the list keys walk, where Enter or a click on a masked row reveals it until the same is done again", async () => {
  variant("mask:tree");
  const workbench = await open(alpha);
  fireEvent.click(screen.getByRole("tab", { name: "Values" }));
  await settle(6);
  const tree = screen.getByRole("tree", { name: "Values" });
  const item = (name: RegExp) => within(tree).getByRole("treeitem", { name });
  const row = item(/password/);
  expect(row.textContent).toContain("16 B");
  expect(row.textContent).not.toContain("<16 bytes>");
  expect(row.getAttribute("aria-level")).toBe("2");
  expect(row.className).toContain("h-6");
  expect(row.querySelector(".font-mono")?.className).not.toContain(
    "text-support",
  );
  const eye = within(row).getByRole("button", {
    name: "Reveal database.password",
  });
  expect(eye.className).toContain("size-6");

  const press = (code: string) => {
    fireEvent.keyDown(tree, { code, key: code });
  };
  const at = () => {
    const id = tree.getAttribute("aria-activedescendant");
    return id === null ? undefined : document.getElementById(id)?.textContent;
  };
  tree.focus();
  expect(at()).toContain("database");
  press("ArrowDown");
  expect(at()).toContain("password");
  press("ArrowLeft");
  expect(at()).toContain("database");
  press("ArrowDown");
  press("Enter");
  await settle(3);
  expect(screen.getByRole("dialog").textContent).toContain(
    "Reveal database.password of release alpha (revision 2)",
  );
  fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
  await settle(4);
  expect(tree.textContent).not.toContain("<16 bytes>");
  expect(tree.querySelector("pre")?.textContent).toBe("user-password-r2");
  expect(tree.querySelector("pre")?.className).toContain("bg-muted");
  expect(item(/password/).textContent).not.toContain("user-password-r2");
  expect(
    within(item(/password/)).getByRole("button", {
      name: "Hide database.password",
    }),
  ).toBeTruthy();
  fireEvent.click(item(/password/));
  await settle(2);
  expect(tree.textContent).not.toContain("user-password-r2");
  expect(tree.querySelector("pre")).toBeNull();
  expect(item(/password/).textContent).toContain("16 B");
  const asked = vi.spyOn(workbench.operations, "run");
  fireEvent.click(
    within(item(/password/)).getByRole("button", {
      name: "Reveal database.password",
    }),
  );
  await settle(3);
  expect(asked).toHaveBeenCalledTimes(1);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: /^Cancel/ }));
  await settle(2);
  fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
  await settle(2);
  expect(screen.queryByRole("tree", { name: "Values" })).toBeNull();
});

test("a release's page has the page's filter, which searches the notes and opens the section that holds a match", async () => {
  await open(alpha);
  expect(document.body.textContent).not.toContain("registry.example/demo:1.2");
  fireEvent.keyDown(screen.getByRole("tab", { name: "Overview" }), {
    code: "Slash",
    key: "/",
  });
  await settle(3);
  const field = screen.getByRole("textbox", { name: "Filter this page" });
  fireEvent.change(field, { target: { value: "registry.example" } });
  await settle(3);
  expect(document.body.textContent).toContain("registry.example/demo:1.2");
  expect(screen.queryByText("Objects")).toBeNull();
  expect(screen.getAllByText("Notes").length).toBeGreaterThan(0);
});

test("Reveal All and Hide All are commands of the page, enabled while there is something to reveal or to hide", async () => {
  variant("mask:tree");
  const workbench = await open(alpha);
  fireEvent.click(screen.getByRole("tab", { name: "Values" }));
  await settle(6);
  const tab = screen.getByRole("tab", { name: "Values" });
  const lookup = () => workbench.keys.lookup(tab);
  const enabled = (id: string) => workbench.commands.enabled(id, lookup());
  expect(enabled("helm.text.revealAll")).toBe(true);
  expect(enabled("helm.text.hideAll")).toBe(false);
  await act(() => workbench.commands.execute("helm.text.revealAll", lookup()));
  await settle(3);
  fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
  await settle(4);
  const tree = screen.getByRole("tree", { name: "Values" });
  expect(tree.textContent).toContain("user-password-r2");
  expect(enabled("helm.text.revealAll")).toBe(false);
  expect(enabled("helm.text.hideAll")).toBe(true);
  await act(() => workbench.commands.execute("helm.text.hideAll", lookup()));
  await settle(2);
  expect(tree.textContent).not.toContain("user-password-r2");
  expect(enabled("helm.text.hideAll")).toBe(false);
});
