import { expect, test, vi } from "vitest";
import { testWorkbench } from "@twigo/workbench/testing";
import type { EditorBuffer } from "./copies";
import { createEdits } from "./services";

test("an editor that closes loses its buffer and keeps its copy", async () => {
  const workbench = await testWorkbench("ready");
  const onClose = vi.spyOn(workbench.editors, "onClose");
  const edits = createEdits(workbench);
  const listener = onClose.mock.calls[0]?.[0];
  if (!listener) throw new Error("the edits do not listen for a close");

  const uri = "k8s://dev//v1/configmaps/default/settings";
  const dispose = vi.fn();
  edits.copies.edit(uri, "data: {}\n", {
    space: "dev",
    base: "{}",
    lock: "7",
  });
  edits.copies.buffer(uri, () => ({
    model: { dispose } as unknown as EditorBuffer["model"],
    view: null,
  }));
  listener(uri);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(edits.copies.get(uri)).toBeDefined();
});
