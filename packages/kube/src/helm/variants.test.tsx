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

test("helm:sidebar is a third container whose rows read the list's batches, a click showing the release as a preview that keeps the focus and a double click keeping it", async () => {
  variant("helm:sidebar");
  const workbench = await mountKube(createMockBackend("ready"));
  const opened = vi.spyOn(workbench.editors, "open");
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Helm" }));
  fireEvent.click(screen.getByRole("tab", { name: "Helm" }));
  await settle(6);
  const grid = screen.getByRole("grid", { name: "Helm releases" });
  const rows = within(grid).getAllByRole("row");
  const [, first] = rows;
  if (!first) throw new Error("no row");
  expect(rows).toHaveLength(6);
  expect(rows[1]?.textContent).toContain("alpha");
  expect(rows[1]?.textContent).toContain("demo-0.1.0");
  expect(rows[1]?.textContent).toContain("payments");
  expect(screen.queryByRole("treeitem", { name: "Helm" })).toBeNull();
  fireEvent.mouseDown(first, { detail: 1 });
  fireEvent.click(first, { detail: 1 });
  expect(opened).toHaveBeenLastCalledWith(alpha, {
    preview: true,
    preserveFocus: true,
  });
  fireEvent.mouseDown(first, { detail: 2 });
  fireEvent.click(first, { detail: 2 });
  fireEvent.doubleClick(first, { detail: 2 });
  expect(opened).toHaveBeenLastCalledWith(alpha, {
    preview: false,
    preserveFocus: false,
  });
});

const clipboard = () => {
  const writeText = vi.fn((_text: string) => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
};

async function helmRows() {
  variant("helm:sidebar");
  const workbench = await mountKube(createMockBackend("ready"));
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Helm" }));
  fireEvent.click(screen.getByRole("tab", { name: "Helm" }));
  await settle(6);
  const grid = screen.getByRole("grid", { name: "Helm releases" });
  const rows = within(grid).getAllByRole("row");
  const row = (name: string) => {
    const found = rows.find((each) => each.textContent.startsWith(name));
    if (!found) throw new Error(`no row ${name}`);
    return found;
  };
  return { workbench, rows, row };
}

test("helm:sidebar's rows are a forward's: a failed or unreadable release is a band, a waiting or unreadable one says its word, and the line takes the row's width", async () => {
  const { row } = await helmRows();
  expect(row("epsilon").dataset.tone).toBe("error");
  expect(row("trunc").dataset.tone).toBe("error");
  expect(row("stuck").dataset.tone).toBe("warn");
  expect(row("alpha").dataset.tone).toBeUndefined();
  expect(row("stuck").textContent).toContain("pending-upgrade");
  expect(row("trunc").textContent).toContain("Truncated");
  expect(row("epsilon").textContent).not.toContain("failed");
  const line = row("beta").querySelector('[role="gridcell"] .inline-flex');
  expect(line?.className).toContain("w-full");
});

test("helm:sidebar's row menu offers Open Release, Copy Name and Copy helm Command, which act on the row it opened on", async () => {
  const writeText = clipboard();
  const { workbench, row } = await helmRows();
  const opened = vi.spyOn(workbench.editors, "open");
  const menu = async (name: string, item: string) => {
    fireEvent.pointerEnter(row(name));
    const trigger = within(row(name)).getByRole("button", {
      name: "Row actions",
    });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    await settle(1);
    fireEvent.click(
      screen.getByRole("menuitem", { name: new RegExp(`^${item}`) }),
    );
    await settle(2);
  };
  await menu("beta", "Copy Name");
  expect(writeText).toHaveBeenLastCalledWith("beta");
  await menu("stuck", "Copy helm Command");
  expect(writeText).toHaveBeenLastCalledWith(
    "helm status stuck --namespace auth --kube-context prod-eu",
  );
  await menu("epsilon", "Open Release");
  expect(opened).toHaveBeenLastCalledWith(
    helmUri({ space: "prod-eu", namespace: "payments", name: "epsilon" }),
  );
});

async function sidebar(scenario: "rbacNamespaces" | "rbacTypedNamespaces") {
  variant("helm:sidebar");
  const workbench = await mountKube(createMockBackend(scenario));
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Helm" }));
  fireEvent.click(screen.getByRole("tab", { name: "Helm" }));
  await settle(60);
  return workbench;
}

test("helm:sidebar says which namespaces it leaves out, as the list does: counted where the credentials may list some, named where one is refused", async () => {
  const workbench = await sidebar("rbacNamespaces");
  const grid = screen.getByRole("grid", { name: "Helm releases" });
  expect(
    within(grid)
      .getAllByRole("row")
      .map((row) => row.textContent),
  ).toHaveLength(2);
  expect(document.body.textContent).toContain(
    "Showing the 1 namespace you may list: these credentials may not list Secrets in the other 11.",
  );
  act(() => {
    workbench.spaces.update("prod-eu", (state) => ({
      ...state,
      namespaces: ["payments", "default", "auth"],
    }));
  });
  await settle(60);
  expect(document.body.textContent).toContain(
    "These credentials may not list Secrets in auth, payments, which Helm keeps its releases in.",
  );
});

test("helm:sidebar says a whole refusal as the list does, in every namespace at once", async () => {
  await sidebar("rbacTypedNamespaces");
  expect(document.body.textContent).toContain(
    "These credentials may not list Secrets in every namespace at once, which Helm keeps its releases in.",
  );
});

test("helm:view is a second view of the Explorer container, and the explorer has no Helm section", async () => {
  variant("helm:view");
  await mountKube(createMockBackend("ready"));
  expect(screen.getByRole("button", { name: /Helm releases/ })).toBeTruthy();
  expect(screen.queryByRole("treeitem", { name: "Helm" })).toBeNull();
  expect(screen.getAllByRole("grid", { name: "Helm releases" })).toHaveLength(
    1,
  );
});

test("mask:tree shows the values as rows of key paths in a tree that the list keys walk, where Enter or a click on a masked row reveals it until the same is done again", async () => {
  variant("mask:tree");
  await open(alpha);
  fireEvent.click(screen.getByRole("tab", { name: "Values" }));
  await settle(6);
  const tree = screen.getByRole("tree", { name: "Values" });
  const item = (name: RegExp) => within(tree).getByRole("treeitem", { name });
  expect(item(/password/).textContent).toContain("<16 bytes>");
  expect(item(/password/).getAttribute("aria-level")).toBe("2");

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
  expect(tree.textContent).toContain("user-password-r2");
  expect(tree.textContent).not.toContain("<16 bytes>");
  fireEvent.click(item(/password/));
  await settle(2);
  expect(tree.textContent).not.toContain("user-password-r2");
  expect(tree.textContent).toContain("<16 bytes>");
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

test("Reveal All Values and Hide All Values are commands of the page, enabled while there is something to reveal or to hide", async () => {
  variant("mask:tree");
  const workbench = await open(alpha);
  fireEvent.click(screen.getByRole("tab", { name: "Values" }));
  await settle(6);
  const tab = screen.getByRole("tab", { name: "Values" });
  const lookup = () => workbench.keys.lookup(tab);
  const enabled = (id: string) => workbench.commands.enabled(id, lookup());
  expect(enabled("helm.values.revealAll")).toBe(true);
  expect(enabled("helm.values.hideAll")).toBe(false);
  await act(() =>
    workbench.commands.execute("helm.values.revealAll", lookup()),
  );
  await settle(3);
  fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
  await settle(4);
  const tree = screen.getByRole("tree", { name: "Values" });
  expect(tree.textContent).toContain("user-password-r2");
  expect(enabled("helm.values.revealAll")).toBe(false);
  expect(enabled("helm.values.hideAll")).toBe(true);
  await act(() => workbench.commands.execute("helm.values.hideAll", lookup()));
  await settle(2);
  expect(tree.textContent).not.toContain("user-password-r2");
  expect(enabled("helm.values.hideAll")).toBe(false);
});
