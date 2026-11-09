import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useEditorShown } from "../react";
import { tabsIn, testWorkbench } from "../testing";
import { WorkbenchView } from "../WorkbenchView";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

const panelElement = () => document.querySelector('[aria-label="Panel"]');

test("the panel is inert while hidden and the editor area while a maximized panel covers it", async () => {
  const { workbench, editors, space } = await mounted();
  act(() => {
    editors.open("note://a");
    editors.open("session://x");
  });
  const note = () => screen.getByText("note note://a");
  expect(panelElement()?.hasAttribute("inert")).toBe(false);
  expect(note().closest("[inert]")).toBeNull();
  act(() => {
    workbench.spaces.setPart(space(), "panel", { visible: false });
  });
  expect(panelElement()?.hasAttribute("inert")).toBe(true);
  expect(note().closest("[inert]")).toBeNull();
  act(() => {
    workbench.spaces.setPart(space(), "panel", {
      visible: true,
      maximized: true,
    });
  });
  expect(panelElement()?.hasAttribute("inert")).toBe(false);
  expect(note().closest("[inert]")).not.toBeNull();
  act(() => {
    workbench.spaces.setPart(space(), "panel", { visible: false });
  });
  expect(panelElement()?.hasAttribute("inert")).toBe(true);
  expect(note().closest("[inert]")).toBeNull();
});

test("the focus leaves a part before the part goes inert", async () => {
  const { workbench, editors, space } = await mounted();
  withFields(workbench);
  act(() => {
    editors.open("field://a");
    editors.open("input://x");
  });
  const inertAtFocus: boolean[] = [];
  const record = () => {
    inertAtFocus.push(panelElement()?.hasAttribute("inert") ?? false);
  };
  act(() => {
    screen.getByLabelText("input://x").focus();
  });
  document.addEventListener("focusin", record);
  act(() => {
    workbench.spaces.setPart(space(), "panel", { visible: false });
  });
  document.removeEventListener("focusin", record);
  expect(document.activeElement).toBe(screen.getByLabelText("field://a"));
  expect(inertAtFocus.length).toBeGreaterThan(0);
  expect(inertAtFocus.every((inert) => !inert)).toBe(true);
  expect(panelElement()?.hasAttribute("inert")).toBe(true);
});

test("an area that an open reveals takes the focus once it is no longer inert", async () => {
  const { workbench, editors, space } = await mounted();
  const inertAtFocus: string[] = [];
  const root = (area: string) =>
    area === "panel"
      ? panelElement()
      : document.querySelector(".twigo-dockview:not(.twigo-panel)");
  const focusing = (area: string) => () => {
    const inert = root(area)?.closest("[inert]") ?? null;
    inertAtFocus.push(`${area}:${String(inert !== null)}`);
  };
  workbench.editors.register({
    id: "test.focusing",
    scheme: "focusing",
    title: (uri) => uri.host,
    component: ({ uri }) => <p>focusing {uri}</p>,
    focus: focusing("editor"),
  });
  workbench.editors.register({
    id: "test.shell",
    scheme: "shell",
    area: "panel",
    title: (uri) => uri.host,
    component: ({ uri }) => <p>shell {uri}</p>,
    focus: focusing("panel"),
  });
  act(() => {
    editors.open("session://x");
  });
  act(() => {
    workbench.spaces.setPart(space(), "panel", { visible: false });
  });
  expect(panelElement()?.hasAttribute("inert")).toBe(true);
  act(() => {
    editors.open("shell://a");
  });
  expect(inertAtFocus).toEqual(["panel:false"]);

  act(() => {
    workbench.spaces.setPart(space(), "panel", { maximized: true });
  });
  expect(document.querySelectorAll("[inert]")).toHaveLength(1);
  inertAtFocus.length = 0;
  act(() => {
    editors.open("focusing://b");
  });
  expect(inertAtFocus).toEqual(["editor:false"]);
});

test("the focus goes back to an element that can take it, else to the editor area's active editor", async () => {
  const { workbench, editors } = await mounted();
  withFields(workbench);
  act(() => {
    editors.open("field://a");
  });
  const back = document.body.appendChild(document.createElement("button"));
  const held = document.body.appendChild(document.createElement("input"));
  act(() => {
    held.focus();
    editors.returnFocus(back);
  });
  expect(document.activeElement).toBe(back);

  act(() => {
    held.focus();
    back.disabled = true;
    editors.returnFocus(back);
  });
  expect(document.activeElement).toBe(screen.getByLabelText("field://a"));

  act(() => {
    held.focus();
    editors.returnFocus(document.body);
  });
  expect(document.activeElement).toBe(screen.getByLabelText("field://a"));

  act(() => {
    held.focus();
    editors.returnFocus(undefined);
  });
  expect(document.activeElement).toBe(screen.getByLabelText("field://a"));
  back.remove();
  held.remove();
});

test("with no editor to take it, what held the focus lets go of it", async () => {
  const { editors } = await mounted();
  const held = document.body.appendChild(document.createElement("input"));
  const gone = document.createElement("button");
  act(() => {
    held.focus();
    editors.returnFocus(gone);
  });
  expect(document.activeElement).toBe(document.body);
  held.remove();
});

test("quick access closes onto the active editor when the element it would restore cannot take the focus", async () => {
  const { workbench, editors } = await mounted();
  withFields(workbench);
  act(() => {
    editors.open("field://a");
    editors.open("input://x");
  });
  const terminal = screen.getByLabelText("input://x");
  act(() => {
    terminal.focus();
  });
  act(() => {
    workbench.quickAccess.show("");
  });
  const field = document.body.appendChild(document.createElement("input"));
  act(() => {
    field.focus();
    (terminal as HTMLInputElement).disabled = true;
    workbench.quickAccess.hide();
  });
  expect(document.activeElement).toBe(screen.getByLabelText("field://a"));
  field.remove();
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

function withTerminal(
  workbench: Awaited<ReturnType<typeof mounted>>["workbench"],
) {
  workbench.editors.register({
    id: "test.terminal",
    scheme: "terminal",
    area: "panel",
    title: (uri) => uri.host,
    component: ({ uri }) => <input aria-label={uri} />,
    focus: (uri) => {
      document.querySelector<HTMLElement>(`[aria-label="${uri}"]`)?.focus();
    },
  });
}

function refuseInertFocus() {
  const focus = Reflect.get(HTMLElement.prototype, "focus");
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    if (this.closest("[inert]") === null) focus.call(this, options);
  });
}

const maximize = (
  workbench: Awaited<ReturnType<typeof mounted>>["workbench"],
) =>
  workbench.commands.execute(
    "workbench.action.maximizePanel",
    workbench.keys.lookup(null),
  );

test("a space that comes back with a maximized panel gives the focus to the panel", async () => {
  refuseInertFocus();
  const { workbench, editors, space } = await mounted();
  withFields(workbench);
  withTerminal(workbench);
  const first = space();
  act(() => {
    editors.open("field://a");
    editors.open("terminal://x");
  });
  await act(() => maximize(workbench));
  const other = workbench.spaces.list.find((each) => each.id !== first);
  if (!other) throw new Error("the mock lists one space");
  act(() => {
    workbench.spaces.select(other.id);
  });
  act(() => {
    workbench.spaces.select(first);
  });
  await act(() => Promise.resolve());
  expect(workbench.spaces.state(first).parts.panel.maximized).toBe(true);
  expect(document.activeElement).toBe(screen.getByLabelText("terminal://x"));
});

test("closing the active editor closes the panel's while a maximized panel covers the editors, whatever has the focus", async () => {
  const { workbench, editors } = await mounted();
  act(() => {
    editors.open("note://a");
    editors.open("session://x");
  });
  await act(() => maximize(workbench));
  const outside = document.body.appendChild(document.createElement("button"));
  act(() => {
    outside.focus();
  });
  const close = () =>
    workbench.commands.execute(
      "workbench.action.closeActiveEditor",
      workbench.keys.lookup(document.activeElement),
    );
  await act(close);
  expect(tabsIn("panel")).toEqual([]);
  expect(tabsIn("editor")).toEqual(["note://a"]);
  await act(close);
  expect(tabsIn("editor")).toEqual(["note://a"]);
  outside.remove();
});
