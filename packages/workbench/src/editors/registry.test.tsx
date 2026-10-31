import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { testWorkbench } from "../testing";
import { WorkbenchView } from "../WorkbenchView";

afterEach(cleanup);

async function mounted() {
  const workbench = await testWorkbench();
  workbench.editors.register({
    id: "test.note",
    scheme: "note",
    title: (uri) => uri.host,
    component: ({ uri }) => <p>body of {uri}</p>,
  });
  render(<WorkbenchView workbench={workbench} />);
  const tabs = () =>
    [...document.querySelectorAll(".dv-tab")].map((tab) => ({
      title: tab.textContent,
      preview: tab
        .querySelector("[data-preview]")
        ?.getAttribute("data-preview"),
    }));
  return { workbench, editors: workbench.editors, tabs };
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

test("a URI nothing opens fails loudly", async () => {
  const { editors } = await mounted();
  expect(() => {
    editors.open("nowhere://x");
  }).toThrow("no editor opens nowhere://x");
});
