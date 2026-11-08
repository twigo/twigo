import { expect, test } from "vitest";
import type { ApplyRequest, Backend } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { Previews, type Subject } from "./previews";

const BASE = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "settings", namespace: "default", resourceVersion: "7" },
  data: { a: "0" },
};

function subject(text: string): Subject {
  return {
    space: "dev",
    opened: {
      target: {
        gvr: { group: "", version: "v1", resource: "configmaps" },
        namespaced: true,
        namespace: "default",
        name: "settings",
      },
      base: BASE,
      lock: "7",
    },
    text,
  };
}

function recording(scenario: Parameters<typeof createMockBackend>[0]) {
  const real = createMockBackend(scenario);
  const sent: ApplyRequest[] = [];
  const backend: Backend = {
    invoke: (command, request) => {
      if (command === "apply_preview") sent.push(request as ApplyRequest);
      return real.invoke(command, request);
    },
    subscribe: (command, request, onMessage) =>
      real.subscribe(command, request, onMessage),
  };
  return { backend, sent };
}

const EDITED =
  "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: settings\n  namespace: default\ndata:\n  a: '1'\n";

test("a text that does not parse stays with where it goes wrong, and nothing is sent", async () => {
  const { backend, sent } = recording("live");
  const previews = new Previews(backend);
  const result = await previews.run(
    "k8s://dev//v1/configmaps/default/settings",
    subject("data:\n  a: [1, 2\n"),
  );
  expect(result).toMatchObject({ state: "failed", at: { line: 3 } });
  expect(sent).toEqual([]);
  expect(previews.get("k8s://dev//v1/configmaps/default/settings")).toBe(
    result,
  );
});

test("the engine's answer is kept with what it was asked of, and Force and Drop ask again with their choice", async () => {
  const { backend, sent } = recording("applyConflicts");
  const previews = new Previews(backend);
  const editor = "k8s://dev//v1/configmaps/default/settings";
  const first = await previews.run(editor, subject(EDITED));
  expect(first).toMatchObject({
    state: "answered",
    answer: { state: "conflicts" },
    forced: false,
    dropped: [],
  });
  expect(sent[0]).toMatchObject({
    space: "dev",
    force: false,
    drop: [],
    opened: { lock: "7", base: BASE },
    edited: { data: { a: "1" } },
  });

  await previews.again(editor, { force: true });
  expect(sent[1]).toMatchObject({ force: true, drop: [] });
  await previews.again(editor, { drop: [".spec.replicas"] });
  expect(sent[2]).toMatchObject({ force: true, drop: [".spec.replicas"] });
});

test("a changed text clears what a bar said, and keeps a ready diff to be read", async () => {
  const bar = recording("applyStale");
  const previews = new Previews(bar.backend);
  await previews.run("a", subject(EDITED));
  previews.edited("a");
  expect(previews.get("a")).toBeUndefined();

  const diff = recording("live");
  const kept = new Previews(diff.backend);
  await kept.run("a", subject(EDITED));
  kept.edited("a");
  expect(kept.get("a")).toMatchObject({ answer: { state: "ready" } });
});

test("an answer that comes after the preview was cleared is dropped", async () => {
  const { backend } = recording("live");
  const previews = new Previews(backend);
  const pending = previews.run("a", subject(EDITED));
  previews.clear("a");
  await pending;
  expect(previews.get("a")).toBeUndefined();
});
