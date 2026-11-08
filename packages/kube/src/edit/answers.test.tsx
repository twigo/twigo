import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ApplyPreviewed } from "@twigo/protocol";
import type { MockScenario } from "@twigo/protocol/mock";
import { inWorkbench } from "@twigo/workbench/testing";
import { setupEdit } from "../../test/edits";
import { PreviewPage } from "./answers";
import { placementOf } from "./placement";

vi.mock("./DiffView", () => ({
  default: ({ original, modified }: { original: string; modified: string }) => (
    <pre data-testid="diff">
      {original}
      {"\n---\n"}
      {modified}
    </pre>
  ),
}));

afterEach(cleanup);

async function shown(scenario: MockScenario, space = "dev") {
  const { workbench, edits, uri, run } = await setupEdit(scenario, space);
  await run("k8s.edit.apply");
  render(
    <PreviewPage
      edits={edits}
      uri={uri}
      preview={edits.previews.get(uri)}
      current={edits.copies.get(uri)?.text ?? ""}
    />,
    { wrapper: inWorkbench(workbench) },
  );
  return screen;
}

const buttons = () =>
  screen.queryAllByRole("button").map((button) => button.textContent.trim());

test("each answer has its own view, with its own choices", async () => {
  await shown("applyUnchanged");
  expect(screen.getByText("Nothing to apply")).toBeTruthy();
  expect(screen.getByText(/Left out: \.status/)).toBeTruthy();
  expect(buttons()).toEqual(["Dismiss"]);
  cleanup();

  await shown("applyConflicts");
  const fields = screen.getByRole("table", { name: "Conflicting fields" });
  expect(within(fields).getByText(".spec.replicas")).toBeTruthy();
  expect(within(fields).getByText("kube-controller-manager")).toBeTruthy();
  expect(buttons()).toEqual(["Force", "Drop my change", "Dismiss"]);
  cleanup();

  await shown("applyStale");
  expect(screen.getByText(/the object has been modified/)).toBeTruthy();
  expect(buttons()).toEqual(["Compare", "Reload", "Keep mine", "Dismiss"]);
  cleanup();

  await shown("applyRecreate");
  expect(screen.getByText(/field is immutable/)).toBeTruthy();
  expect(buttons()).toEqual(["Delete and recreate", "Dismiss"]);
  cleanup();

  await shown("applyImmutable");
  expect(screen.getByText(/field is immutable/)).toBeTruthy();
  expect(buttons()).toEqual(["Dismiss"]);
});

test("a ready answer shows the diff, the warnings, the removals as their own step and what was left out", async () => {
  await shown("applyRemovals");
  expect((await screen.findByTestId("diff")).textContent).toContain("data:");
  expect(screen.getByText("The server warns")).toBeTruthy();
  expect(screen.getByText(/this annotation is deprecated/)).toBeTruthy();
  expect(screen.getByText(/A separate step removes:/)).toBeTruthy();
  expect(screen.getByText(".metadata.labels.team")).toBeTruthy();
  expect(screen.getByText(/Left out of what is sent:/)).toBeTruthy();
  expect(screen.queryByText(/One merge patch/)).toBeNull();
  expect(buttons()).toEqual(["Apply"]);
});

test("an edit that goes as one merge patch says so and why", async () => {
  await shown("applyMergePatch");
  const note = screen.getByText(/One merge patch/).closest("p");
  expect(note?.textContent).toContain("cannot express this edit");
  expect(note?.textContent).toContain("twigo-edit");
  expect(screen.queryByText(/A separate step removes/)).toBeNull();
  expect(screen.getByText(/Removed by the patch:/)).toBeTruthy();
});

test("a read-only context says so in the chip's words, and a writable one does not", async () => {
  await shown("live", "prod-eu");
  expect(screen.getByText("Production · read-only")).toBeTruthy();
  expect(await screen.findByTestId("diff")).toBeTruthy();
  cleanup();

  await shown("live", "dev");
  expect(screen.queryByText(/read-only/)).toBeNull();
});

test("a diff of a text that changed since is outdated and cannot be applied", async () => {
  const { workbench, edits, uri, run } = await setupEdit("live");
  await run("k8s.edit.apply");
  edits.copies.edit(uri, `${EDITED_PLUS}\n`, {
    space: "dev",
    base: "{}",
    lock: "7",
  });
  render(
    <PreviewPage
      edits={edits}
      uri={uri}
      preview={edits.previews.get(uri)}
      current={edits.copies.get(uri)?.text ?? ""}
    />,
    { wrapper: inWorkbench(workbench) },
  );
  expect(screen.getByText("The YAML changed after this preview")).toBeTruthy();
  const apply = screen.getByRole("button", { name: "Apply" });
  expect(apply.hasAttribute("disabled")).toBe(true);
});

const EDITED_PLUS = "apiVersion: v1\nkind: ConfigMap\ndata:\n  a: '2'";

test("a ready answer shows in a tab of its own, and the others in a bar over the editor", () => {
  const answers: Record<ApplyPreviewed["state"], ApplyPreviewed> = {
    unchanged: { state: "unchanged", ignored: [] },
    ready: {
      state: "ready",
      id: 1,
      live: null,
      result: {},
      warnings: [],
      removals: [],
      ignored: [],
      strategy: "serverSideApply",
    },
    conflicts: { state: "conflicts", conflicts: [] },
    stale: { state: "stale", message: "", keepable: true },
    immutable: { state: "immutable", message: "", recreate: null },
  };
  expect(
    Object.fromEntries(
      Object.entries(answers).map(([state, answer]) => [
        state,
        placementOf(answer),
      ]),
    ),
  ).toEqual({
    unchanged: "bar",
    ready: "page",
    conflicts: "bar",
    stale: "bar",
    immutable: "bar",
  });
});
