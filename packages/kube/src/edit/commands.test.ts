import { expect, test, vi } from "vitest";
import { diffUri } from "../uri";
import { base, EDITED, setupEdit } from "../../test/edits";

test("Apply… dry-runs the edit and opens its diff, and Apply applies it and ends the edit", async () => {
  const { edits, open, close, uri, run } = await setupEdit("live");
  await run("k8s.edit.apply");
  expect(edits.previews.get(uri)).toMatchObject({
    state: "answered",
    answer: { state: "ready" },
  });
  expect(open).toHaveBeenCalledWith(diffUri({ kind: "apply", editor: uri }));
  expect(edits.copies.get(uri)).toBeDefined();

  await run("k8s.edit.confirm");
  await vi.waitFor(() => {
    expect(edits.copies.get(uri)).toBeUndefined();
  });
  expect(edits.previews.get(uri)).toBeUndefined();
  expect(close).toHaveBeenCalledWith(diffUri({ kind: "apply", editor: uri }));
});

test("in read-only the dry run and the diff work and Apply is refused by the gate, so the edit stays", async () => {
  const { workbench, edits, sent, uri, run } = await setupEdit(
    "live",
    "prod-eu",
  );
  await run("k8s.edit.apply");
  expect(sent).toHaveLength(1);
  expect(edits.previews.get(uri)).toMatchObject({
    answer: { state: "ready" },
  });

  const operation = vi.spyOn(workbench.operations, "run");
  await run("k8s.edit.confirm");
  expect(await operation.mock.results[0]?.value).toEqual({ state: "failed" });
  expect(edits.copies.get(uri)).toBeDefined();
  expect(edits.previews.get(uri)).toMatchObject({
    answer: { state: "ready" },
  });
});

test("a text that does not parse stays in the editor, with no diff and nothing sent", async () => {
  const { edits, sent, open, uri, run } = await setupEdit("live");
  edits.copies.edit(uri, "data:\n  a: [1, 2\n", {
    space: "dev",
    base: JSON.stringify(base),
    lock: "7",
  });
  await run("k8s.edit.apply");
  expect(edits.previews.get(uri)).toMatchObject({
    state: "failed",
    at: { line: 3 },
  });
  expect(sent).toEqual([]);
  expect(open).not.toHaveBeenCalledWith(
    diffUri({ kind: "apply", editor: uri }),
  );
  expect(edits.copies.get(uri)?.text).toBe("data:\n  a: [1, 2\n");
});

test("Keep mine sends the old base, the new lock and the object at that lock", async () => {
  const { edits, sent, uri, run } = await setupEdit("applyStale");
  const theirs = {
    ...base,
    metadata: { ...base.metadata, resourceVersion: "9" },
    data: { a: "0", b: "theirs" },
  };
  edits.copies.see(uri, JSON.stringify(theirs), false);
  expect(edits.copies.serverChanged(uri)).toBe(true);

  await run("k8s.edit.apply");
  expect(edits.previews.get(uri)).toMatchObject({ answer: { state: "stale" } });
  expect(sent[0]?.opened).toMatchObject({ lock: "7", base });
  expect(sent[0]?.opened?.locked).toBeUndefined();

  await run("k8s.edit.keepMine");
  expect(sent).toHaveLength(2);
  expect(sent[1]?.opened).toMatchObject({ lock: "9", base, locked: theirs });
  expect(edits.copies.get(uri)?.text).toBe(EDITED);
  expect(edits.copies.serverChanged(uri)).toBe(false);
});

test("Force and Drop my change ask for a new preview with their choice, and Dismiss clears the bar", async () => {
  const { edits, sent, uri, run } = await setupEdit("applyConflicts");
  await run("k8s.edit.apply");
  await run("k8s.edit.force");
  expect(sent[1]).toMatchObject({ force: true, drop: [] });
  await run("k8s.edit.dropMine");
  expect(sent[2]).toMatchObject({
    force: true,
    drop: [".spec.replicas", ".metadata.labels.team"],
  });
  expect(edits.copies.get(uri)?.text).toBe(EDITED);
  await run("k8s.edit.dismiss");
  expect(edits.previews.get(uri)).toBeUndefined();
});

test("Delete and recreate plans by the preview's id and asks first, as it destroys", async () => {
  const { workbench, edits, uri, run } = await setupEdit("applyRecreate");
  await run("k8s.edit.apply");
  expect(edits.previews.get(uri)).toMatchObject({
    answer: { state: "immutable" },
  });
  const done = run("k8s.edit.recreate");
  await vi.waitFor(() => {
    expect(workbench.operations.asking).toBeDefined();
  });
  expect(workbench.operations.asking?.plan).toMatchObject({
    destructive: true,
    confirm: "Delete and recreate configmap settings",
  });
  workbench.operations.asking?.confirm(undefined);
  await done;
  await vi.waitFor(() => {
    expect(edits.copies.get(uri)).toBeUndefined();
  });
});
