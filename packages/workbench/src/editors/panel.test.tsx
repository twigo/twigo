import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useEditorShown } from "../react";
import { tabsIn, testWorkbench } from "../testing";
import { WorkbenchView } from "../WorkbenchView";

afterEach(cleanup);

const shown = new Map<string, boolean>();

function Shown({ uri }: { uri: string }) {
  shown.set(uri, useEditorShown());
  return null;
}

async function mounted() {
  const workbench = await testWorkbench();
  workbench.editors.register({
    id: "test.note",
    scheme: "note",
    title: (uri) => uri.host,
    component: ({ uri }) => <p>note {uri}</p>,
  });
  workbench.editors.register({
    id: "test.session",
    scheme: "session",
    area: "panel",
    title: (uri) => uri.host,
    component: ({ uri }) => <p>session {uri}</p>,
  });
  workbench.editors.register({
    id: "test.shown",
    scheme: "shown",
    title: (uri) => uri.host,
    component: Shown,
  });
  render(<WorkbenchView workbench={workbench} />);
  const space = () => workbench.spaces.active?.id ?? "";
  const panel = () => workbench.spaces.state(space()).parts.panel;
  return { workbench, editors: workbench.editors, space, panel };
}

test("an editor of the panel opens there, shows the panel, and leaves the editor area's active editor", async () => {
  const { editors, panel } = await mounted();
  act(() => {
    editors.open("note://a");
  });
  expect(panel().visible).toBe(false);
  act(() => {
    editors.open("session://x");
  });
  expect(panel().visible).toBe(true);
  expect(editors.active).toBe("note://a");
  expect(editors.activeIn("panel")).toBe("session://x");
  expect(tabsIn("panel")).toEqual(["session://x"]);
  expect(tabsIn("editor")).toEqual(["note://a"]);
});

test("an editor is shown only while it is the active tab of its group and no maximized panel covers its area", async () => {
  const { workbench, editors, space } = await mounted();
  act(() => {
    editors.open("shown://a");
    editors.open("session://x");
  });
  expect(shown.get("shown://a")).toBe(true);
  act(() => {
    editors.open("shown://b");
  });
  expect(shown.get("shown://a")).toBe(false);
  expect(shown.get("shown://b")).toBe(true);
  act(() => {
    workbench.spaces.setPart(space(), "panel", { maximized: true });
  });
  expect(shown.get("shown://b")).toBe(false);
  act(() => {
    workbench.spaces.setPart(space(), "panel", { maximized: false });
  });
  expect(shown.get("shown://b")).toBe(true);
});

test("a focus that fell to the page goes to the panel when it is maximized over the editors", async () => {
  const { workbench, editors, space } = await mounted();
  act(() => {
    editors.open("shown://a");
    editors.open("session://x");
  });
  act(() => {
    (document.activeElement as HTMLElement).blur();
  });
  expect(document.activeElement).toBe(document.body);
  act(() => {
    workbench.spaces.setPart(space(), "panel", { maximized: true });
  });
  expect(document.activeElement?.closest('[aria-label="Panel"]')).toBeTruthy();
});

function withFields(
  workbench: Awaited<ReturnType<typeof mounted>>["workbench"],
) {
  workbench.editors.register({
    id: "test.field",
    scheme: "field",
    title: (uri) => uri.host,
    component: ({ uri }) => <input aria-label={uri} />,
    focus: (uri) => {
      document.querySelector<HTMLElement>(`[aria-label="${uri}"]`)?.focus();
    },
  });
  workbench.editors.register({
    id: "test.input",
    scheme: "input",
    area: "panel",
    title: (uri) => uri.host,
    component: ({ uri }) => <input aria-label={uri} />,
  });
}

test("hiding the panel moves the focus it held to the editor area's active editor", async () => {
  const { workbench, editors, space } = await mounted();
  withFields(workbench);
  act(() => {
    editors.open("field://a");
    editors.open("input://x");
  });
  act(() => {
    screen.getByLabelText("input://x").focus();
  });
  act(() => {
    workbench.spaces.setPart(space(), "panel", { visible: false });
  });
  expect(document.activeElement).toBe(screen.getByLabelText("field://a"));
});

test("hiding the panel leaves the page without a focus when the editor area has no editor", async () => {
  const { workbench, editors, space } = await mounted();
  withFields(workbench);
  act(() => {
    editors.open("input://x");
  });
  act(() => {
    screen.getByLabelText("input://x").focus();
  });
  act(() => {
    workbench.spaces.setPart(space(), "panel", { visible: false });
  });
  expect(document.activeElement).toBe(document.body);
});

test("hiding the panel does not take a focus that is elsewhere", async () => {
  const { workbench, editors, space } = await mounted();
  withFields(workbench);
  act(() => {
    editors.open("field://a");
    editors.open("input://x");
  });
  const outside = document.body.appendChild(document.createElement("input"));
  act(() => {
    outside.focus();
  });
  act(() => {
    workbench.spaces.setPart(space(), "panel", { visible: false });
  });
  expect(document.activeElement).toBe(outside);
  outside.remove();
});

test("a panel maximized over the editor area takes the focus the editors held", async () => {
  const { workbench, editors, space } = await mounted();
  withFields(workbench);
  act(() => {
    editors.open("field://a");
    editors.open("input://x");
  });
  act(() => {
    screen.getByLabelText("field://a").focus();
  });
  await act(() =>
    workbench.commands.execute(
      "workbench.action.maximizePanel",
      workbench.keys.lookup(null),
    ),
  );
  expect(workbench.spaces.state(space()).parts.panel.maximized).toBe(true);
  expect(document.activeElement?.closest('[aria-label="Panel"]')).toBeTruthy();
});

test("an open URI is focused where it is, in either area", async () => {
  const { workbench, editors, space } = await mounted();
  act(() => {
    editors.open("session://x");
    editors.open("session://y");
  });
  act(() => {
    workbench.spaces.setPart(space(), "panel", { visible: false });
  });
  act(() => {
    editors.open("session://x");
  });
  expect(tabsIn("panel").sort()).toEqual(["session://x", "session://y"]);
  expect(editors.activeIn("panel")).toBe("session://x");
  expect(workbench.spaces.state(space()).parts.panel.visible).toBe(true);
});

test("closing a panel editor tells the close listeners, and its title can change", async () => {
  const { editors } = await mounted();
  const closed = vi.fn();
  editors.onClose(closed);
  act(() => {
    editors.open("session://x");
  });
  act(() => {
    editors.setTitle("session://x", "Logs · pod x");
  });
  expect(editors.title("session://x")).toBe("Logs · pod x");
  act(() => {
    editors.close("session://x");
  });
  expect(closed).toHaveBeenCalledWith("session://x");
  expect(tabsIn("panel")).toEqual([]);
});

test("closing the panel's last editor gives the focus to the editor area's active group", async () => {
  const { workbench, editors } = await mounted();
  workbench.editors.register({
    id: "test.input",
    scheme: "input",
    area: "panel",
    title: (uri) => uri.host,
    component: ({ uri }) => <input aria-label={uri} />,
  });
  act(() => {
    editors.open("note://a");
    editors.open("input://x");
  });
  act(() => {
    screen.getByLabelText("input://x").focus();
  });
  act(() => {
    editors.close("input://x");
  });
  expect(tabsIn("panel")).toEqual([]);
  expect(document.activeElement).not.toBe(document.body);
  expect(
    document.activeElement?.contains(screen.getByText("note note://a")),
  ).toBe(true);
});

test("the panel maximizes, restores and hides by its commands, and its menu offers the one that applies", async () => {
  const { workbench, panel } = await mounted();
  act(() => {
    workbench.editors.open("session://x");
  });
  const offered = () =>
    workbench
      .actions("panel/title", workbench.keys.lookup(null))
      .flat()
      .map((action) => action.id);
  expect(offered()).toEqual([
    "workbench.action.maximizePanel",
    "workbench.action.closePanel",
  ]);
  await act(() =>
    workbench.commands.execute(
      "workbench.action.maximizePanel",
      workbench.keys.lookup(null),
    ),
  );
  expect(panel()).toEqual({ visible: true, maximized: true });
  expect(offered()).toEqual([
    "workbench.action.restorePanel",
    "workbench.action.closePanel",
  ]);
  await act(() =>
    workbench.commands.execute(
      "workbench.action.closePanel",
      workbench.keys.lookup(null),
    ),
  );
  expect(panel()).toEqual({ visible: false, maximized: true });
});

test("the panel's layout comes back with its space", async () => {
  const { workbench, editors, space } = await mounted();
  act(() => {
    editors.open("session://x");
  });
  await act(() => Promise.resolve());
  const saved = workbench.spaces.state(space()).panelEditors;
  expect(JSON.stringify(saved)).toContain("session://x");
  cleanup();
  render(<WorkbenchView workbench={workbench} />);
  expect(tabsIn("panel")).toEqual(["session://x"]);
});

test("an editor that opens in the editor area restores a maximized panel", async () => {
  const { workbench, editors, panel } = await mounted();
  act(() => {
    editors.open("session://x");
  });
  await act(() =>
    workbench.commands.execute(
      "workbench.action.maximizePanel",
      workbench.keys.lookup(null),
    ),
  );
  expect(panel()).toEqual({ visible: true, maximized: true });
  act(() => {
    editors.open("note://a");
  });
  expect(panel()).toEqual({ visible: true, maximized: false });
});

test("closing the active editor closes the panel's while the panel has the focus", async () => {
  const { workbench, editors } = await mounted();
  act(() => {
    editors.open("note://a");
    editors.open("session://x");
  });
  const panel = document.querySelector('[aria-label="Panel"]');
  const focusable = panel?.querySelector<HTMLElement>("p") ?? null;
  focusable?.setAttribute("tabindex", "-1");
  focusable?.focus();
  await act(() =>
    workbench.commands.execute(
      "workbench.action.closeActiveEditor",
      workbench.keys.lookup(document.activeElement),
    ),
  );
  expect(tabsIn("panel")).toEqual([]);
  expect(tabsIn("editor")).toEqual(["note://a"]);
});

test("the panel's tabs come back after a switch to another space and back", async () => {
  const { workbench, editors, space } = await mounted();
  const first = space();
  act(() => {
    editors.open("session://x");
  });
  const other = workbench.spaces.list.find((each) => each.id !== first);
  if (!other) throw new Error("the mock lists one space");
  act(() => {
    workbench.spaces.select(other.id);
  });
  expect(tabsIn("panel")).toEqual([]);
  act(() => {
    workbench.spaces.select(first);
  });
  expect(tabsIn("panel")).toEqual(["session://x"]);
});
