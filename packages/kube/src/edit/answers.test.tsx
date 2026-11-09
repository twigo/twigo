import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ApplyPreviewed } from "@twigo/protocol";
import type { MockScenario } from "@twigo/protocol/mock";
import { inWorkbench } from "@twigo/workbench/testing";
import { setupEdit } from "../../test/edits";
import { AnswerView, PreviewPage } from "./answers";
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
  expect(
    screen.getByText(
      "Nothing is left to apply: .status is left out of what is sent. Your YAML still holds it.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/says what the object has now/)).toBeNull();
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

  await shown("applyListsMoved");
  expect(
    screen.getByText(/so keeping yours would revert that change/),
  ).toBeTruthy();
  expect(screen.queryByText(/Keep mine applies/)).toBeNull();
  expect(buttons()).toEqual(["Compare", "Reload", "Dismiss"]);
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

test("under a policy file's lock the diff says so in the chip's words and offers no Apply", async () => {
  await shown("policyFile", "prod-eu");
  expect(screen.getByText("Production · read-only")).toBeTruthy();
  expect(await screen.findByTestId("diff")).toBeTruthy();
  const note = screen.getByText(/Apply is not offered/).textContent;
  expect(note).toContain(
    "prod-* in /Library/Application Support/Twigo/policy.json sets this",
  );
  expect(note).toContain("Twigo cannot change or unlock it");
  expect(
    screen.queryByText(/refused until the context is unlocked/),
  ).toBeNull();
  expect(buttons()).toEqual([]);
  cleanup();

  await shown("live", "prod-eu");
  expect(
    screen.getByText(/refused until the context is unlocked/),
  ).toBeTruthy();
});

test("under a policy file's lock the Immutable bar says why in the chip's words, not what Delete and recreate would do", async () => {
  const immutable = {
    state: "immutable",
    message: "spec.selector is immutable",
    recreate: 7,
  } as const;
  const view = async (scenario: MockScenario) => {
    const { workbench, edits, uri } = await setupEdit(scenario, "prod-eu");
    render(
      <AnswerView
        edits={edits}
        uri={uri}
        answer={immutable}
        dropped={[]}
        space="prod-eu"
        outdated={false}
      />,
      { wrapper: inWorkbench(workbench) },
    );
  };
  await view("live");
  expect(screen.getByText(/deletes the object and creates it/)).toBeTruthy();
  cleanup();

  await view("policyFile");
  expect(screen.queryByText(/deletes the object and creates it/)).toBeNull();
  const note = screen.getByText(/Delete and recreate is not offered/);
  expect(note.textContent).toContain("Production · read-only:");
  expect(note.textContent).toContain(
    "prod-* in /Library/Application Support/Twigo/policy.json",
  );
  expect(buttons()).not.toContain("Delete and recreate");
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

test("giving up every conflicting field says nothing is left to send and that the text still holds the change", async () => {
  const { workbench, edits, uri, run } = await setupEdit("applyConflicts");
  await run("k8s.edit.apply");
  await run("k8s.edit.dropMine");
  const preview = edits.previews.get(uri);
  render(
    <PreviewPage
      edits={edits}
      uri={uri}
      preview={preview}
      current={edits.copies.get(uri)?.text ?? ""}
    />,
    { wrapper: inWorkbench(workbench) },
  );
  expect(screen.getByText("Nothing to apply")).toBeTruthy();
  const note = screen.getByText(/Nothing is left to send/).textContent;
  expect(note).toContain(".spec.replicas, .metadata.labels.team are out of it");
  expect(note).toContain("Your YAML still holds your values");
  expect(screen.queryByText(/says what the object has now/)).toBeNull();
});

test("an unchanged answer that left several fields out says so, and that the text holds them", async () => {
  const { workbench, edits, uri } = await setupEdit("live");
  render(
    <AnswerView
      edits={edits}
      uri={uri}
      answer={{
        state: "unchanged",
        ignored: [".status", ".metadata.uid"],
      }}
      dropped={[]}
      space="dev"
      outdated={false}
    />,
    { wrapper: inWorkbench(workbench) },
  );
  expect(
    screen.getByText(
      "Nothing is left to apply: .status, .metadata.uid are left out of what is sent. Your YAML still holds them.",
    ),
  ).toBeTruthy();
});

test("an unchanged answer with no field given up says the YAML is the object", async () => {
  const { workbench, edits, uri } = await setupEdit("live");
  render(
    <AnswerView
      edits={edits}
      uri={uri}
      answer={{ state: "unchanged", ignored: [] }}
      dropped={[]}
      space="dev"
      outdated={false}
    />,
    { wrapper: inWorkbench(workbench) },
  );
  expect(
    screen.getByText(/The YAML says what the object has now/),
  ).toBeTruthy();
});

test("a diff names the context it applies to, and nothing previewed has an empty state", async () => {
  await shown("live", "prod-eu");
  expect(screen.getByText("on")).toBeTruthy();
  expect(screen.getByText("prod-eu")).toBeTruthy();
  cleanup();

  const { workbench, edits, uri } = await setupEdit("live");
  render(
    <PreviewPage edits={edits} uri={uri} preview={undefined} current="" />,
    { wrapper: inWorkbench(workbench) },
  );
  expect(screen.getByText("Nothing is being previewed")).toBeTruthy();
  expect(screen.getByText("Apply the edit to see its diff.")).toBeTruthy();
});
