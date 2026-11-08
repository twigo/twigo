import { expect, test } from "vitest";
import {
  comparable,
  kindOf,
  parseManifest,
  statusLines,
  yamlOfJson,
} from "./object";

test("strings YAML 1.1 reads as booleans stay quoted", () => {
  const yaml = yamlOfJson(
    JSON.stringify({ data: { enabled: "yes", flag: "on", mode: "fast" } }),
  );
  expect(yaml).toContain('enabled: "yes"');
  expect(yaml).toContain('flag: "on"');
  expect(yaml).toContain("mode: fast");
});

test("a manifest is the one object it names, read as the YAML it was written in", () => {
  const parsed = parseManifest("kind: ConfigMap\ndata:\n  a: 'yes'\n  b: 5\n");
  expect(parsed).toEqual({
    ok: true,
    object: { kind: "ConfigMap", data: { a: "yes", b: 5 } },
  });
  expect(parseManifest("a: yes\n")).toEqual({ ok: true, object: { a: true } });
});

test("a parse error says where the text goes wrong", () => {
  const parsed = parseManifest("kind: ConfigMap\ndata:\n  a: [1, 2\n");
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.line).toBe(4);
  expect(parsed.message).not.toBe("");
  expect(parsed.message).not.toMatch(/line \d+/);
});

test("several documents, none, and a list at the root are errors, not something left out", () => {
  const several = parseManifest("a: 1\n---\nb: 2\n");
  expect(several).toMatchObject({ ok: false, line: 2 });
  expect(several.ok || several.message).toContain("2 documents");
  expect(parseManifest("# nothing\n")).toMatchObject({ ok: false });
  expect(parseManifest("- a\n- b\n")).toMatchObject({ ok: false });
  expect(parseManifest("a: 1\n---\n")).toMatchObject({ ok: true });
});

test("the lines of status are found, flow style and a missing block included", () => {
  const text =
    "kind: Deployment\nspec:\n  replicas: 1\nstatus:\n  ready: 1\n  items:\n    - a\nmetadata: {}\n";
  expect(statusLines(text)).toEqual({ from: 4, to: 7 });
  expect(statusLines("a: 1\nstatus: {}\n")).toEqual({ from: 2, to: 2 });
  expect(statusLines("a: 1\n")).toBeUndefined();
  expect(statusLines("a: [\n")).toBeUndefined();
});

test("a status write does not change an object where status is a subresource, and does elsewhere", () => {
  const before = JSON.stringify({
    metadata: { name: "a", resourceVersion: "1", generation: 1 },
    spec: { replicas: 1 },
    status: { ready: 0 },
  });
  const status = JSON.stringify({
    metadata: { name: "a", resourceVersion: "2", generation: 1 },
    spec: { replicas: 1 },
    status: { ready: 1 },
  });
  const spec = JSON.stringify({
    metadata: { name: "a", resourceVersion: "3", generation: 2 },
    spec: { replicas: 2 },
    status: { ready: 0 },
  });
  expect(comparable(status, true)).toBe(comparable(before, true));
  expect(comparable(spec, true)).not.toBe(comparable(before, true));
  expect(comparable(status, false)).not.toBe(comparable(before, false));
});

test("the kind of an object comes from its apiVersion and kind", () => {
  expect(kindOf({ apiVersion: "apps/v1", kind: "Deployment" })).toEqual({
    group: "apps",
    version: "v1",
    kind: "Deployment",
  });
  expect(kindOf({ apiVersion: "v1", kind: "Pod" })).toEqual({
    group: "",
    version: "v1",
    kind: "Pod",
  });
  expect(kindOf({ kind: "Pod" })).toBeUndefined();
});
