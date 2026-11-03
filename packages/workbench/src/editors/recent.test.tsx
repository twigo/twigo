import { act, cleanup, render } from "@testing-library/react";
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
  const open = (uri: string, options?: { side?: boolean }) => {
    act(() => {
      workbench.editors.open(uri, options);
    });
  };
  const groups = () =>
    [...document.querySelectorAll(".dv-groupview")].map((group) =>
      [...group.querySelectorAll(".dv-tab")].map((tab) => tab.textContent),
    );
  return { workbench, open, groups };
}

test("an editor opened to the side gets a new group to the right of the active one", async () => {
  const { workbench, open, groups } = await mounted();
  open("note://a");
  open("note://b");
  open("note://c", { side: true });
  expect(groups()).toEqual([["a", "b"], ["c"]]);
  expect(workbench.editors.active).toBe("note://c");
  open("note://a", { side: true });
  expect(groups()).toEqual([["a", "b"], ["c"]]);
  expect(workbench.editors.active).toBe("note://a");
});

test("each space keeps the editors it opened, newest first, in its state", async () => {
  const { workbench, open } = await mounted();
  open("note://a");
  open("note://b");
  open("note://a");
  act(() => {
    workbench.spaces.select("staging");
  });
  open("note://staged");
  expect(workbench.recent.list("prod-eu")).toEqual([
    { uri: "note://a", title: "a" },
    { uri: "note://b", title: "b" },
  ]);
  expect(workbench.recent.list("staging")).toEqual([
    { uri: "note://staged", title: "staged" },
  ]);
  await workbench.state.settled();
  const stored = await workbench.backend.invoke("state_load", null);
  expect(JSON.parse(stored.spaces.staging?.recent ?? "null")).toEqual([
    { uri: "note://staged", title: "staged" },
  ]);
});

test("a recent editor takes the title its editor gives it", async () => {
  const { workbench, open } = await mounted();
  open("note://pods");
  act(() => {
    workbench.editors.setTitle("note://pods", "Pods");
  });
  expect(workbench.recent.list("prod-eu")).toEqual([
    { uri: "note://pods", title: "Pods" },
  ]);
});

test("a space keeps its last twenty editors", async () => {
  const { workbench, open } = await mounted();
  for (let index = 0; index < 25; index++) open(`note://n${String(index)}`);
  const recent = workbench.recent.list("prod-eu");
  expect(recent).toHaveLength(20);
  expect(recent[0]?.uri).toBe("note://n24");
  expect(recent[19]?.uri).toBe("note://n5");
});
