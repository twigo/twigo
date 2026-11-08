import { expect, test, vi } from "vitest";
import { notify } from "@twigo/ui";
import { diffUri } from "../uri";
import { editLookup } from "./services";
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
  expect(edits.copies.held(uri)).toBe(EDITED);
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
  expect(await operation.mock.results[0]?.value).toEqual({
    state: "refused",
  });
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

test("a manifest of two documents stays in the editor, with the line of the second and nothing sent", async () => {
  const { edits, sent, open, uri, run } = await setupEdit("live");
  const text = `${EDITED}---\n${EDITED}`;
  edits.copies.edit(uri, text, {
    space: "dev",
    base: JSON.stringify(base),
    lock: "7",
  });
  await run("k8s.edit.apply");
  expect(edits.previews.get(uri)).toMatchObject({
    state: "failed",
    at: { line: 8 },
  });
  expect(sent).toEqual([]);
  expect(open).not.toHaveBeenCalledWith(
    diffUri({ kind: "apply", editor: uri }),
  );
  expect(edits.copies.get(uri)?.text).toBe(text);
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

test("Force and Drop my change ask for a new preview with their choice, as the engine answers them, and Dismiss clears the bar", async () => {
  const { edits, sent, uri, run } = await setupEdit("applyConflicts");
  await run("k8s.edit.apply");
  await run("k8s.edit.force");
  expect(sent[1]).toMatchObject({ force: true, drop: [] });
  expect(edits.previews.get(uri)).toMatchObject({
    answer: { state: "ready" },
    forced: true,
  });

  await run("k8s.edit.apply");
  expect(edits.previews.get(uri)).toMatchObject({
    answer: { state: "conflicts" },
  });
  await run("k8s.edit.dropMine");
  expect(sent[3]).toMatchObject({
    force: false,
    drop: [".spec.replicas", ".metadata.labels.team"],
  });
  expect(edits.previews.get(uri)).toMatchObject({
    answer: { state: "unchanged" },
    dropped: [".spec.replicas", ".metadata.labels.team"],
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
  expect(edits.copies.held(uri)).toBe(EDITED);
});

test("Cancel, a failed run and a stopped run clear the preview, which the plan took, and close its diff", async () => {
  const { workbench, edits, close, uri, run } = await setupEdit(
    "live",
    "staging",
  );
  const diff = diffUri({ kind: "apply", editor: uri });
  await run("k8s.edit.apply");
  const cancelled = run("k8s.edit.confirm");
  await vi.waitFor(() => {
    expect(workbench.operations.asking).toBeDefined();
  });
  workbench.operations.asking?.cancel();
  await cancelled;
  expect(edits.previews.get(uri)).toBeUndefined();
  expect(close).toHaveBeenCalledWith(diff);
  expect(edits.copies.get(uri)).toBeDefined();

  for (const state of ["failed", "stopped"] as const) {
    await run("k8s.edit.apply");
    expect(edits.previews.get(uri)).toBeDefined();
    vi.spyOn(workbench.operations, "run").mockResolvedValueOnce({ state });
    await run("k8s.edit.confirm");
    expect(edits.previews.get(uri), state).toBeUndefined();
    expect(edits.copies.get(uri), state).toBeDefined();
  }
});

test("text typed while the plan runs stays, and the copy is not ended as if it was applied", async () => {
  const { workbench, edits, uri, run } = await setupEdit("live");
  await run("k8s.edit.apply");
  const typed = `${EDITED}# typed after Apply\n`;
  const real = workbench.operations.run.bind(workbench.operations);
  vi.spyOn(workbench.operations, "run").mockImplementation((request, look) => {
    edits.copies.edit(uri, typed, {
      space: "dev",
      base: JSON.stringify(base),
      lock: "7",
    });
    return real(request, look);
  });
  await run("k8s.edit.confirm");
  await vi.waitFor(() => {
    expect(edits.previews.get(uri)).toBeUndefined();
  });
  expect(edits.copies.get(uri)?.text).toBe(typed);
  expect(edits.copies.held(uri)).toBeUndefined();
});

test("another target context ends the preview and its diff, which named the old one", async () => {
  const { workbench, edits, close } = await setupEdit("live", "dev");
  const manifest = "untitled://manifest-7";
  edits.copies.write(
    manifest,
    "dev",
    "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fresh\n  namespace: default\n",
  );
  const pick = vi.spyOn(workbench.quickAccess, "pick");
  const lookup = () => editLookup(edits, manifest, workbench.keys.lookup(null));
  const execute = (id: string) =>
    workbench.commands.execute(id, lookup(), { uri: manifest });
  pick.mockResolvedValueOnce({ id: "dev", label: "dev" });
  await execute("k8s.edit.apply");
  expect(edits.previews.get(manifest)).toMatchObject({
    answer: { state: "ready" },
    subject: { space: "dev" },
  });

  pick.mockResolvedValueOnce({ id: "staging", label: "staging" });
  await execute("k8s.manifest.target");
  expect(edits.copies.get(manifest)?.target).toBe("staging");
  expect(edits.previews.get(manifest)).toBeUndefined();
  expect(close).toHaveBeenCalledWith(
    diffUri({ kind: "apply", editor: manifest }),
  );

  pick.mockResolvedValueOnce({ id: "staging", label: "staging" });
  await execute("k8s.edit.apply");
  pick.mockClear();
  await execute("k8s.manifest.target");
  expect(edits.previews.get(manifest)).toMatchObject({ state: "answered" });
});

test("an empty manifest has no target context to change, a manifest with text has", async () => {
  const { workbench, edits } = await setupEdit("live", "dev");
  const manifest = "untitled://manifest-8";
  const offered = () =>
    workbench
      .actions(
        "edit/toolbar",
        editLookup(edits, manifest, workbench.keys.lookup(null)),
        { uri: manifest },
      )
      .flat()
      .map(({ id }) => id);
  expect(offered()).not.toContain("k8s.manifest.target");
  edits.copies.write(manifest, "dev", "kind: ConfigMap\n");
  expect(offered()).toContain("k8s.manifest.target");
});

test("a preview that a newer one or a clear replaced while it was asked opens nothing", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { edits, open, uri, run } = await setupEdit("live", "dev", gate);
  const diff = diffUri({ kind: "apply", editor: uri });
  const abandoned = run("k8s.edit.apply");
  await vi.waitFor(() => {
    expect(edits.previews.get(uri)).toMatchObject({ state: "running" });
  });
  open.mockClear();
  edits.previews.clear(uri);
  release();
  await abandoned;
  expect(open).not.toHaveBeenCalled();
  expect(edits.previews.get(uri)).toBeUndefined();

  await run("k8s.edit.apply");
  expect(open).toHaveBeenCalledWith(diff);
});

test("an answer that comes after the person left the space stays with its editor, which offers to show it", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { workbench, edits, open, uri, run } = await setupEdit(
    "live",
    "dev",
    gate,
  );
  const diff = diffUri({ kind: "apply", editor: uri });
  const asked = run("k8s.edit.apply");
  await vi.waitFor(() => {
    expect(edits.previews.get(uri)).toMatchObject({ state: "running" });
  });
  workbench.spaces.select("staging");
  open.mockClear();
  release();
  await asked;
  expect(open).not.toHaveBeenCalled();
  expect(edits.previews.get(uri)).toMatchObject({
    answer: { state: "ready" },
    shown: false,
  });

  workbench.spaces.select("dev");
  const keys = editLookup(edits, uri, workbench.keys.lookup(null));
  expect(keys("edit.unshown")).toBe(true);
  await run("k8s.edit.show");
  expect(open).toHaveBeenCalledWith(diff);
  expect(edits.previews.get(uri)).toMatchObject({ shown: true });
  expect(
    editLookup(edits, uri, workbench.keys.lookup(null))("edit.unshown"),
  ).toBe(false);
});

test("a plan done in another space than its editor's ends the copy and opens nothing", async () => {
  const { workbench, edits, open, uri, run } = await setupEdit("live", "dev");
  await run("k8s.edit.apply");
  open.mockClear();
  vi.spyOn(workbench.operations, "run").mockImplementationOnce(() => {
    workbench.spaces.select("staging");
    return Promise.resolve({ state: "done" });
  });
  await run("k8s.edit.confirm");
  expect(edits.copies.get(uri)).toBeUndefined();
  expect(edits.copies.held(uri)).toBe(EDITED);
  expect(open).not.toHaveBeenCalled();
});

const MANIFEST =
  "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fresh\n  namespace: default\ndata:\n  a: '1'\n";

test("a manifest applied to another context stays, and a toast says what was made where and goes there", async () => {
  const { workbench, edits, discovery, open, close } = await setupEdit(
    "live",
    "dev",
  );
  workbench.spaces.select("staging");
  await discovery.resources("staging");
  workbench.spaces.select("dev");
  const manifest = "untitled://manifest-3";
  edits.copies.write(manifest, "dev", MANIFEST);
  vi.spyOn(workbench.quickAccess, "pick").mockResolvedValue({
    id: "staging",
    label: "staging",
  });
  const toast = vi.spyOn(notify, "success");
  vi.spyOn(workbench.operations, "run").mockResolvedValue({ state: "done" });
  const execute = (id: string) =>
    workbench.commands.execute(
      id,
      editLookup(edits, manifest, workbench.keys.lookup(null)),
      { uri: manifest },
    );
  await execute("k8s.edit.apply");
  expect(edits.previews.get(manifest)).toMatchObject({
    subject: { space: "staging" },
  });
  open.mockClear();
  close.mockClear();
  await execute("k8s.edit.confirm");

  expect(edits.copies.get(manifest)?.text).toBe(MANIFEST);
  expect(close).not.toHaveBeenCalledWith(manifest);
  expect(open).not.toHaveBeenCalledWith(
    expect.stringContaining("k8s://staging"),
  );
  const [message, options] =
    toast.mock.calls[toast.mock.calls.length - 1] ?? [];
  expect(message).toBe("Created ConfigMap default/fresh in staging");
  expect(options?.action?.label).toBe("Open in staging");

  options?.action?.run();
  expect(workbench.spaces.active?.id).toBe("staging");
  expect(open).toHaveBeenCalledWith(
    "k8s://staging//v1/configmaps/default/fresh",
  );
});

test("a manifest applied to its own context opens the object it made and ends", async () => {
  const { workbench, edits, discovery, open, close } = await setupEdit(
    "live",
    "dev",
  );
  await discovery.resources("dev");
  const manifest = "untitled://manifest-4";
  edits.copies.write(manifest, "dev", MANIFEST);
  vi.spyOn(workbench.quickAccess, "pick").mockResolvedValue({
    id: "dev",
    label: "dev",
  });
  const execute = (id: string) =>
    workbench.commands.execute(
      id,
      editLookup(edits, manifest, workbench.keys.lookup(null)),
      { uri: manifest },
    );
  await execute("k8s.edit.apply");
  await execute("k8s.edit.confirm");
  expect(edits.copies.get(manifest)).toBeUndefined();
  expect(open).toHaveBeenCalledWith("k8s://dev//v1/configmaps/default/fresh");
  expect(close).toHaveBeenCalledWith(manifest);
});

test("a diff tab acts on the edit it shows, ⌘S stays off it, and the palette's Apply is there", async () => {
  const { workbench, edits, uri, run } = await setupEdit("live", "dev");
  await run("k8s.edit.apply");
  const diff = diffUri({ kind: "apply", editor: uri });
  vi.spyOn(workbench.editors, "active", "get").mockReturnValue(diff);
  workbench.editors.changes.emit();
  const lookup = workbench.keys.lookup(null);
  expect(lookup("edit.applicable")).toBe(true);
  expect(lookup("edit.dirty")).toBe(true);
  const palette = workbench
    .actions("commandPalette", lookup)
    .flat()
    .map(({ id }) => id);
  expect(palette).toContain("k8s.edit.confirm");

  const operation = vi.spyOn(workbench.operations, "run");
  await workbench.commands.execute("k8s.edit.confirm", lookup);
  expect(operation).toHaveBeenCalledTimes(1);
  expect(edits.copies.get(uri)).toBeUndefined();

  expect(workbench.keybindings.primary("k8s.edit.apply")?.whenSource).toContain(
    "editor.type!=kube.diff",
  );
});

test("a bar's action and a diff's end give the focus back to the editor", async () => {
  const { edits, uri, run } = await setupEdit("applyStale");
  const focus = vi.spyOn(edits.copies, "focus");
  await run("k8s.edit.apply");
  expect(focus).toHaveBeenCalledWith(uri);
  focus.mockClear();
  await run("k8s.edit.dismiss");
  expect(focus).toHaveBeenCalledWith(uri);
  focus.mockClear();
  await run("k8s.edit.discard");
  expect(focus).toHaveBeenCalledWith(uri);

  const ready = await setupEdit("live");
  const afterDiff = vi.spyOn(ready.edits.copies, "focus");
  await ready.run("k8s.edit.apply");
  expect(afterDiff).not.toHaveBeenCalled();
  await ready.run("k8s.edit.confirm");
  expect(afterDiff).toHaveBeenCalledWith(ready.uri);
});
