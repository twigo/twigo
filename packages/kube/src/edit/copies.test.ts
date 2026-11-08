import { expect, test, vi } from "vitest";
import type { Backend } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { StateStore } from "@twigo/workbench";
import { WorkingCopies, type EditorBuffer } from "./copies";
import { yamlOfJson } from "./object";

const DEPLOYMENT = "k8s://prod-eu/apps/v1/deployments/default/web";
const SECRET = "k8s://prod-eu//v1/secrets/default/credentials";

const base = JSON.stringify({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web", namespace: "default", resourceVersion: "10" },
  spec: { replicas: 1 },
  status: { readyReplicas: 1 },
});
const opened = { space: "prod-eu", base, lock: "10" };

async function services(backend = createMockBackend("ready")) {
  const state = await StateStore.load(backend, () => undefined);
  const dirty = new Map<string, boolean>();
  const copies = new WorkingCopies(
    state,
    {
      setDirty: (uri, is) => {
        dirty.set(uri, is);
      },
    },
    ["prod-eu"],
  );
  return { backend, state, copies, dirty };
}

test("the first change makes a copy based on the opened object, and the object's own text ends it", async () => {
  const { copies, dirty } = await services();
  expect(copies.get(DEPLOYMENT)).toBeUndefined();
  copies.edit(DEPLOYMENT, "replicas: 2\n", opened);
  expect(copies.get(DEPLOYMENT)).toEqual({
    space: "prod-eu",
    base,
    lock: "10",
    locked: undefined,
    text: "replicas: 2\n",
  });
  expect(dirty.get(DEPLOYMENT)).toBe(true);
  copies.edit(DEPLOYMENT, "replicas: 3\n", {
    ...opened,
    base: "{}",
    lock: "99",
  });
  expect(copies.get(DEPLOYMENT)).toMatchObject({ base, lock: "10" });
  copies.edit(DEPLOYMENT, yamlOfJson(base), opened);
  expect(copies.get(DEPLOYMENT)).toBeUndefined();
  expect(dirty.get(DEPLOYMENT)).toBe(false);
});

test("a status write is no change on the server where status is a subresource, and a spec write is", async () => {
  const { copies } = await services();
  copies.edit(DEPLOYMENT, "replicas: 2\n", opened);
  const statusOnly = JSON.stringify({
    ...JSON.parse(base),
    metadata: { name: "web", namespace: "default", resourceVersion: "11" },
    status: { readyReplicas: 0 },
  });
  const spec = JSON.stringify({
    ...JSON.parse(statusOnly),
    spec: { replicas: 4 },
  });
  copies.see(DEPLOYMENT, base, true);
  expect(copies.serverChanged(DEPLOYMENT)).toBe(false);
  copies.see(DEPLOYMENT, statusOnly, true);
  expect(copies.serverChanged(DEPLOYMENT)).toBe(false);
  copies.see(DEPLOYMENT, statusOnly, false);
  expect(copies.serverChanged(DEPLOYMENT)).toBe(true);
  copies.see(DEPLOYMENT, spec, true);
  expect(copies.serverChanged(DEPLOYMENT)).toBe(true);
});

test("Keep mine locks to the new version, keeps the old base and asks again only for a later change", async () => {
  const { copies } = await services();
  copies.edit(DEPLOYMENT, "replicas: 2\n", opened);
  const theirs = JSON.stringify({
    ...JSON.parse(base),
    metadata: { name: "web", namespace: "default", resourceVersion: "12" },
    spec: { replicas: 4 },
  });
  copies.see(DEPLOYMENT, theirs, true);
  expect(copies.serverChanged(DEPLOYMENT)).toBe(true);
  copies.keepMine(DEPLOYMENT);
  expect(copies.get(DEPLOYMENT)).toMatchObject({
    base,
    lock: "12",
    locked: theirs,
    text: "replicas: 2\n",
  });
  expect(copies.serverChanged(DEPLOYMENT)).toBe(false);
  const later = JSON.stringify({
    ...JSON.parse(theirs),
    metadata: { name: "web", namespace: "default", resourceVersion: "13" },
    spec: { replicas: 5 },
  });
  copies.see(DEPLOYMENT, later, true);
  expect(copies.serverChanged(DEPLOYMENT)).toBe(true);
  copies.edit(DEPLOYMENT, "replicas: 3\n", opened);
  expect(copies.get(DEPLOYMENT)).toMatchObject({ lock: "12", locked: theirs });
});

test("copies survive a restart in their space, and mark their editors again", async () => {
  const first = await services();
  first.copies.edit(DEPLOYMENT, "replicas: 2\n", opened);
  first.copies.write("untitled://manifest-1", "prod-eu", "kind: ConfigMap\n");
  first.copies.flush();
  await first.state.settled();

  const next = await services(first.backend);
  expect(next.copies.get(DEPLOYMENT)).toEqual({
    space: "prod-eu",
    base,
    lock: "10",
    locked: undefined,
    text: "replicas: 2\n",
  });
  expect(next.dirty.get(DEPLOYMENT)).toBe(true);
  expect(next.copies.get("untitled://manifest-1")).toMatchObject({
    base: undefined,
    text: "kind: ConfigMap\n",
  });
  next.copies.drop(DEPLOYMENT);
  next.copies.flush();
  await next.state.settled();
  const last = await services(first.backend);
  expect(last.copies.get(DEPLOYMENT)).toBeUndefined();
  expect(last.copies.get("untitled://manifest-1")).toBeDefined();
});

test("what the person typed into a Secret never reaches the state", async () => {
  const typed = "password: hunter2-typed-by-hand";
  const secret = JSON.stringify({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "credentials",
      namespace: "default",
      resourceVersion: "5",
    },
    data: { password: "<13 bytes>" },
  });
  const sent: string[] = [];
  const real = createMockBackend("ready");
  const backend: Backend = {
    invoke: (command, request) => {
      if (command === "state_set") sent.push(JSON.stringify(request));
      return real.invoke(command, request);
    },
    subscribe: (command, request, onMessage) =>
      real.subscribe(command, request, onMessage),
  };
  const { copies, state } = await services(backend);

  copies.edit(SECRET, typed, { space: "prod-eu", base: secret, lock: "5" });
  copies.edit(DEPLOYMENT, "replicas: 2\n", opened);
  copies.write("untitled://manifest-1", "prod-eu", `${typed}\nkind: Secret\n`);
  copies.write("untitled://manifest-2", "prod-eu", `${typed}\n`);
  copies.write("untitled://manifest-3", "prod-eu", "kind: ConfigMap\n");
  copies.flush();
  await state.settled();

  expect(copies.get(SECRET)?.text).toBe(typed);
  expect(sent.join("")).not.toContain("hunter2");
  const stored = await backend.invoke("state_load", null);
  const edits = JSON.parse(stored.spaces["prod-eu"]?.edits ?? "{}") as Record<
    string,
    unknown
  >;
  expect(Object.keys(edits).sort()).toEqual([
    DEPLOYMENT,
    "untitled://manifest-3",
  ]);
});

function fakeBuffer() {
  const dispose = vi.fn();
  const buffer: EditorBuffer = {
    model: { dispose } as unknown as EditorBuffer["model"],
    view: null,
  };
  return { buffer, dispose };
}

test("an editor's buffer is made once and kept for as long as the editor lives, its copy outliving it", async () => {
  const { copies } = await services();
  copies.edit(DEPLOYMENT, "replicas: 2\n", opened);
  const first = fakeBuffer();
  const make = vi.fn(() => first.buffer);
  expect(copies.buffer(DEPLOYMENT, make)).toBe(first.buffer);
  first.buffer.view = {} as EditorBuffer["view"];
  expect(copies.buffer(DEPLOYMENT, make)).toBe(first.buffer);
  expect(make).toHaveBeenCalledTimes(1);
  expect(first.dispose).not.toHaveBeenCalled();

  copies.closed(DEPLOYMENT);
  expect(first.dispose).toHaveBeenCalledTimes(1);
  expect(copies.get(DEPLOYMENT)?.text).toBe("replicas: 2\n");
  const second = fakeBuffer();
  expect(copies.buffer(DEPLOYMENT, () => second.buffer)).toBe(second.buffer);
  copies.closed("k8s://prod-eu/apps/v1/deployments/default/other");
  expect(second.dispose).not.toHaveBeenCalled();
});
