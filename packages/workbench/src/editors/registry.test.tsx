import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { testWorkbench } from "../testing";
import { WorkbenchView } from "../WorkbenchView";

afterEach(cleanup);

async function mounted() {
  const workbench = await testWorkbench();
  const unregister = workbench.editors.register({
    id: "test.note",
    scheme: "note",
    title: (uri) => uri.host,
    space: (uri) => uri.searchParams.get("space") ?? undefined,
    component: ({ uri }) => <p>body of {uri}</p>,
  });
  render(
    <StrictMode>
      <WorkbenchView workbench={workbench} />
    </StrictMode>,
  );
  const tabs = () =>
    [...document.querySelectorAll(".dv-tab")].map((tab) => ({
      title: tab.textContent,
      preview: tab
        .querySelector("[data-preview]")
        ?.getAttribute("data-preview"),
    }));
  return { workbench, editors: workbench.editors, tabs, unregister };
}

test("opening a URI shows its editor and makes it the active one", async () => {
  const { workbench, editors, tabs } = await mounted();
  act(() => {
    editors.open("note://first");
  });
  expect(tabs()).toEqual([{ title: "first", preview: "false" }]);
  expect(screen.getByText("body of note://first")).toBeTruthy();
  expect(editors.active).toBe("note://first");
  expect(workbench.keys.lookup(null)("editor.type")).toBe("test.note");
});

test("a preview replaces the previous preview, and pinning keeps it", async () => {
  const { editors, tabs } = await mounted();
  act(() => {
    editors.open("note://a", { preview: true });
  });
  act(() => {
    editors.open("note://b", { preview: true });
  });
  expect(tabs()).toEqual([{ title: "b", preview: "true" }]);
  act(() => {
    editors.pin("note://b");
  });
  act(() => {
    editors.open("note://c", { preview: true });
  });
  expect(tabs()).toEqual([
    { title: "b", preview: "false" },
    { title: "c", preview: "true" },
  ]);
});

test("opening an open URI focuses it; opening it for good pins it", async () => {
  const { editors, tabs } = await mounted();
  act(() => {
    editors.open("note://a", { preview: true });
    editors.open("note://b");
  });
  act(() => {
    editors.open("note://a");
  });
  expect(editors.active).toBe("note://a");
  expect(tabs()).toEqual([
    { title: "a", preview: "false" },
    { title: "b", preview: "false" },
  ]);
});

test("an editor with changes of its own is pinned and marked, also when it opens again", async () => {
  const { editors, tabs } = await mounted();
  const marks = () =>
    document.querySelectorAll('[role="img"][aria-label="Unsaved changes"]')
      .length;
  act(() => {
    editors.open("note://a", { preview: true });
  });
  act(() => {
    editors.setDirty("note://a", true);
  });
  expect(tabs()).toEqual([{ title: "a", preview: "false" }]);
  expect(marks()).toBe(1);
  act(() => {
    editors.open("note://b", { preview: true });
  });
  expect(tabs().map(({ title }) => title)).toEqual(["a", "b"]);
  act(() => {
    editors.close("note://a");
  });
  expect(marks()).toBe(0);
  act(() => {
    editors.open("note://a", { preview: true });
  });
  expect(tabs()).toEqual([
    { title: "b", preview: "true" },
    { title: "a", preview: "false" },
  ]);
  expect(marks()).toBe(1);
  act(() => {
    editors.setDirty("note://a", false);
  });
  expect(marks()).toBe(0);
});

test("each space keeps its own editors", async () => {
  const { workbench, editors, tabs } = await mounted();
  act(() => {
    editors.open("note://prod");
  });
  act(() => {
    workbench.spaces.select("staging");
  });
  expect(tabs()).toEqual([]);
  expect(workbench.keys.lookup(null)("editor.type")).toBeUndefined();
  act(() => {
    workbench.spaces.select("prod-eu");
  });
  expect(tabs()).toEqual([{ title: "prod", preview: "false" }]);
});

test("an editor of another space never lands in the dock of the one shown, and opens once its space is", async () => {
  const { workbench, editors, tabs } = await mounted();
  act(() => {
    editors.open("note://later?space=staging");
    editors.open("note://here?space=prod-eu");
  });
  expect(tabs()).toEqual([{ title: "here", preview: "false" }]);
  expect(editors.active).toBe("note://here?space=prod-eu");

  act(() => {
    workbench.spaces.select("staging");
  });
  expect(tabs()).toEqual([{ title: "later", preview: "false" }]);
  expect(editors.active).toBe("note://later?space=staging");

  act(() => {
    workbench.spaces.select("prod-eu");
  });
  expect(tabs()).toEqual([{ title: "here", preview: "false" }]);
});

test("an editor waiting for a space that does not come next is forgotten", async () => {
  const { workbench, editors, tabs } = await mounted();
  act(() => {
    editors.open("note://later?space=staging");
  });
  act(() => {
    workbench.spaces.select("dev");
  });
  act(() => {
    workbench.spaces.select("staging");
  });
  expect(tabs()).toEqual([]);
  act(() => {
    workbench.spaces.select("prod-eu");
  });
  expect(tabs()).toEqual([]);
});

test("closing an editor says so, while moving it or switching spaces does not", async () => {
  const { workbench, editors } = await mounted();
  const closed: string[] = [];
  editors.onClose((uri) => closed.push(uri));
  act(() => {
    editors.open("note://a");
    editors.open("note://b");
  });
  act(() => {
    void workbench.commands.execute(
      "workbench.action.moveEditorToRightGroup",
      workbench.keys.lookup(null),
    );
  });
  expect(document.querySelectorAll(".dv-groupview")).toHaveLength(2);
  act(() => {
    workbench.spaces.select("staging");
  });
  act(() => {
    workbench.spaces.select("prod-eu");
  });
  expect(closed).toEqual([]);
  act(() => {
    editors.close("note://b");
  });
  expect(closed).toEqual(["note://b"]);
});

test("a URI nothing opens fails loudly", async () => {
  const { editors } = await mounted();
  expect(() => {
    editors.open("nowhere://x");
  }).toThrow("no editor opens nowhere://x");
});

test("the editor commands work on a restored editor nothing opens", async () => {
  const { workbench, editors, tabs, unregister } = await mounted();
  act(() => {
    editors.open("note://a", { preview: true });
  });
  act(() => {
    workbench.spaces.select("staging");
    unregister();
  });
  act(() => {
    workbench.spaces.select("prod-eu");
  });
  expect(screen.getByText("Nothing opens this")).toBeTruthy();
  const lookup = workbench.keys.lookup(null);
  expect(lookup("editor.type")).toBeUndefined();
  await act(() =>
    workbench.commands.execute("workbench.action.keepEditor", lookup),
  );
  expect(tabs()).toEqual([{ title: "a", preview: "false" }]);
  await act(() =>
    workbench.commands.execute("workbench.action.closeActiveEditor", lookup),
  );
  expect(tabs()).toEqual([]);
});
