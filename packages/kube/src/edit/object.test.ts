import { expect, test } from "vitest";
import recorded from "../../test/k8s-yaml/read.json";
import {
  comparable,
  kindOf,
  parseManifest,
  statusLines,
  yamlOfJson,
  yamlOfObject,
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

test("a second document is named by the line of its ---, wherever the first begins", () => {
  expect(parseManifest("---\na: 1\n---\nb: 2\n")).toMatchObject({
    ok: false,
    line: 3,
    column: 1,
  });
  expect(
    parseManifest("# one\na: 1\n\n--- # two\nb: 2\n---\nc: 3\n"),
  ).toMatchObject({
    ok: false,
    line: 4,
    message: expect.stringContaining("3 documents") as unknown,
  });
  expect(parseManifest("---\na: 1\n---\n# nothing more\n")).toMatchObject({
    ok: true,
  });
});

test("an alias with no anchor and a merge of something else than maps are errors at their line, never thrown", () => {
  expect(
    parseManifest("spec:\n  rules:\n    - host: *.example.com\n"),
  ).toMatchObject({
    ok: false,
    line: 3,
    column: 13,
    message: "The alias *.example.com has no anchor.",
  });
  expect(parseManifest("a: 1\nv:\n  <<: 1\n")).toMatchObject({
    ok: false,
    line: 3,
    column: 7,
    message: "A merge key takes a map or a list of maps.",
  });
  expect(parseManifest("v:\n  <<: [1]\n")).toMatchObject({
    ok: false,
    line: 2,
  });
  expect(parseManifest("v:\n  <<: *missing\n")).toMatchObject({
    ok: false,
    line: 2,
    message: "The alias *missing has no anchor.",
  });
  expect(
    parseManifest("b: &b {x: 1}\nv:\n  <<: [*b, {w: 2}]\n  z: 3\n"),
  ).toEqual({ ok: true, object: { b: { x: 1 }, v: { x: 1, w: 2, z: 3 } } });
});

test("aliases that expand past the package's limit are an error at the manifest, not a throw", () => {
  const levels = Array.from(
    { length: 14 },
    (_, level) =>
      `l${String(level)}: &l${String(level)} [${level === 0 ? "x" : `*l${String(level - 1)}, *l${String(level - 1)}`}]`,
  );
  const parsed = parseManifest(`${levels.join("\n")}\n`);
  expect(parsed).toMatchObject({ ok: false, line: 1 });
  expect(parsed.ok || parsed.message).toMatch(/alias/i);
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

const objectOf = (text: string): unknown => {
  const parsed = parseManifest(text);
  return parsed.ok ? parsed.object : parsed;
};

test("every text kubectl was recorded reading is read the same, or refused for a reason Twigo names", () => {
  const refusals = [
    /^The integer .* is past 2\^53/,
    /^Map keys must be unique/,
    /^Twigo does not read the tag /,
  ];
  let same = 0;
  for (const [text, answer] of Object.entries(
    recorded as Record<string, string>,
  )) {
    const parsed = parseManifest(text);
    const read = answer.startsWith("ERROR ")
      ? undefined
      : (JSON.parse(answer) as unknown);
    const isObject =
      typeof read === "object" && read !== null && !Array.isArray(read);
    if (!isObject) {
      expect(parsed.ok, `${JSON.stringify(text)} is no object to kubectl`).toBe(
        false,
      );
    } else if (parsed.ok) {
      expect(parsed.object, JSON.stringify(text)).toEqual(read);
      same++;
    } else {
      expect(
        refusals.some((refusal) => refusal.test(parsed.message)),
        `${JSON.stringify(text)}: ${parsed.message}`,
      ).toBe(true);
    }
  }
  expect(same).toBeGreaterThan(Object.keys(recorded).length / 2);
});

test("a date, a time and a set are what kubectl reads them as, plain values", () => {
  for (const value of [
    "2024-01-01",
    "2001-12-14t21:59:43.10-05:00",
    "2001-12-14 21:59:43.10 -5",
    "22:22",
    "1:30",
    "12:30:00",
    "190:20:30",
  ]) {
    expect(objectOf(`v: ${value}\n`)).toEqual({ v: value });
    expect(objectOf(`${value}: a\n`)).toEqual({ [value]: "a" });
  }
  expect(objectOf("v: 0o777\n")).toEqual({ v: 511 });
  expect(objectOf("v: -0o17\n")).toEqual({ v: -15 });
  expect(objectOf("v: 0X1F\n")).toEqual({ v: 31 });
  expect(objectOf("v: 1e400\n")).toEqual({ v: "1e400" });
  expect(objectOf("v: 9007199254740992\n")).toEqual({ v: 9007199254740992 });
});

test("what JSON cannot say, and what Twigo does not read, is a parse error at its line", () => {
  expect(parseManifest("a: 1\nv: 9007199254740993\n")).toMatchObject({
    ok: false,
    line: 2,
    column: 4,
    message:
      "The integer 9007199254740993 is past 2^53, which JSON cannot carry exactly.",
  });
  expect(parseManifest("a: 1\n18446744073709551616: x\n")).toMatchObject({
    ok: false,
    line: 2,
  });
  for (const inf of [".inf", "-.INF", ".nan", ".NaN"]) {
    expect(parseManifest(`a: 1\nv: ${inf}\n`)).toMatchObject({
      ok: false,
      line: 2,
      message: `${inf} is a number JSON cannot say.`,
    });
  }
  for (const [tagged, name] of [
    ["!!set {a, b}", "!!set"],
    ["!!omap [a: 1]", "!!omap"],
    ["!!binary aGVsbG8=", "!!binary"],
    ["!!float 1", "!!float"],
    ["!!timestamp 2024-01-01", "!!timestamp"],
    ["!local x", "!local"],
  ] as const) {
    expect(parseManifest(`a: 1\nv: ${tagged}\n`)).toMatchObject({
      ok: false,
      line: 2,
      column: 4,
      message: `Twigo does not read the tag ${name}`,
    });
  }
  expect(objectOf("v: !!str 12\n")).toEqual({ v: "12" });
  expect(parseManifest("a: 1\n~: b\n")).toMatchObject({
    ok: false,
    line: 2,
    message: "A key cannot be empty.",
  });
  expect(parseManifest("? [a]\n: b\n")).toMatchObject({
    ok: false,
    line: 1,
    message: "A key must be a single value.",
  });
});

test("what the editor writes reads back as the same object, a key named << among them", () => {
  const strings = [
    "yes",
    "on",
    "null",
    "~",
    "0777",
    "0o777",
    "0x1F",
    "1e3",
    "22:22",
    "1:30",
    "2024-01-01",
    "2001-12-14t21:59:43.10-05:00",
    "<<",
    "=",
    ".inf",
    ".nan",
    "9007199254740993",
    "- a",
    "a: b",
    "# c",
    "!x",
    "*a",
    "&a",
    "a\nb",
    "a\n",
    " lead",
    "---",
    "",
  ];
  for (const string of strings) {
    const object = { v: string, list: [string], [`k${string}`]: 1 };
    expect(objectOf(yamlOfObject(object)), JSON.stringify(string)).toEqual(
      object,
    );
    if (string !== "") {
      const keyed = { [string]: 1 };
      expect(objectOf(yamlOfObject(keyed)), JSON.stringify(string)).toEqual(
        keyed,
      );
    }
  }
  expect(yamlOfObject({ "<<": 1, nested: { "<<": { a: 1 } } })).toContain(
    '"<<": 1',
  );
});
