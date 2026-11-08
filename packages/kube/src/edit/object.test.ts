import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import recorded from "../../test/k8s-yaml/read.json";
import writtenByGo from "../../test/k8s-yaml/written.json";
import { awkward, COUNT, generated, SEED } from "../../test/k8s-yaml/values";
import { mayHoldSecret } from "./copies";
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

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : isObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;

test("every recorded text reads as Go reads it, or is refused for a reason listed in refused.json", async () => {
  const refused: Record<string, string> = {};
  let matched = 0;
  let refusedByBoth = 0;
  for (const [text, answer] of Object.entries(
    recorded as Record<string, string>,
  )) {
    const parsed = parseManifest(text);
    const go =
      answer === "UNSTABLE" || answer.startsWith("ERROR ")
        ? undefined
        : (JSON.parse(answer) as unknown);
    if (!parsed.ok) {
      if (isObject(go)) refused[text] = parsed.message;
      else refusedByBoth++;
      continue;
    }
    expect(
      isObject(go),
      `${JSON.stringify(text)} reads as ${answer} in Go`,
    ).toBe(true);
    expect(parsed.object, JSON.stringify(text)).toEqual(go);
    matched++;
  }
  await expect(
    `${JSON.stringify(
      { matched, refusedByBoth, refused: canonical(refused) },
      null,
      2,
    )}\n`,
  ).toMatchFileSnapshot("../../test/k8s-yaml/refused.json");
});

test("no text throws, whatever it holds", () => {
  for (const text of Object.keys(recorded)) {
    expect(() => parseManifest(text), JSON.stringify(text)).not.toThrow();
    expect(() => statusLines(text), JSON.stringify(text)).not.toThrow();
    expect(
      () => mayHoldSecret("untitled://manifest-1", text),
      JSON.stringify(text),
    ).not.toThrow();
  }
});

test("every written value reads back equal in our reader and in Go, whose reading written.json records", () => {
  const values = [...awkward(), ...generated(SEED, COUNT)];
  const digest = createHash("sha256");
  for (const value of values) {
    const text = yamlOfObject(value);
    digest.update(text).update("\0");
    const parsed = parseManifest(text);
    expect(parsed.ok, `${JSON.stringify(text)} is refused`).toBe(true);
    expect(
      parsed.ok ? JSON.stringify(canonical(parsed.object)) : undefined,
      JSON.stringify(text),
    ).toBe(JSON.stringify(canonical(value)));
  }
  expect({
    texts: String(values.length),
    digest: digest.digest("hex"),
  }).toEqual(writtenByGo);
});

test("an anchor that holds its own alias is an error at the alias, not a throw", () => {
  for (const [text, line] of [
    ["a: &x {b: *x}\n", 1],
    ["a: &x [*x]\n", 1],
    ["--- &a\nb: *a\n", 2],
    ["a: &x {<<: *x}\n", 1],
  ] as const) {
    expect(parseManifest(text), text).toMatchObject({
      ok: false,
      line,
      message: expect.stringContaining("contains itself") as unknown,
    });
  }
});

const roundTrip = (value: string): unknown => {
  const object = { v: value };
  const text = yamlOfObject(object);
  const parsed = parseManifest(text);
  return parsed.ok ? parsed.object : text;
};

test("a multi-line string goes in the block form only where it reads back whole", () => {
  const indented = `  ${"word ".repeat(30).trimEnd()}\nx`;
  for (const value of [indented, "\ta\nb", " \n", "a\n  \nb", "\n a"]) {
    expect(roundTrip(value)).toEqual({ v: value });
  }
  expect(yamlOfObject({ v: "\ta\nb" })).toContain('"\\ta\\nb"');
  expect(yamlOfObject({ v: "a\nb\n" })).toBe("v: |\n  a\n  b\n");
});

test("characters Go folds or refuses are written as escapes and refused raw at their line", () => {
  for (const character of ["\u0085", "\u2028", "\u2029", "\u007f", "\u0080"]) {
    const value = `a${character}b`;
    expect(roundTrip(value)).toEqual({ v: value });
    expect(yamlOfObject({ v: value })).not.toContain(character);
    expect(parseManifest(`a: 1\nv: a${character}b\n`)).toMatchObject({
      ok: false,
      line: 2,
    });
  }
  expect(parseManifest("a: |\n  b\u0085  c\n")).toMatchObject({ ok: false });
  expect(parseManifest('v: "\\/"\n')).toMatchObject({ ok: false, line: 1 });
  expect(parseManifest('v: "\\uD83D"\n')).toMatchObject({ ok: false });
  expect(parseManifest('v: "\\\\/"\n')).toEqual({
    ok: true,
    object: { v: "\\/" },
  });
  expect(parseManifest("\ta: 1\n")).toMatchObject({ ok: false, line: 1 });
});

test("numbers read as Go reads them, by the rules of its resolver", () => {
  for (const [text, value] of [
    [".", "."],
    ["0_", 0],
    ["0x_", "0x_"],
    ["._5", "._5"],
    [".5_", ".5_"],
    [".0_1", 0.01],
    ["+_1", 1],
    ["-_1", -1],
    ["1e1_0", 10000000000],
    ["1e3_", 1000],
    ["010", 8],
    ["09", 9],
    ["0o17", 15],
    ["0b101", 5],
    ["0b-11", -3],
    ["1_000", 1000],
    ["1e400", "1e400"],
    ["1.", 1],
    ["+.5", 0.5],
  ] as const) {
    expect(objectOf(`v: ${text}\n`), text).toEqual({ v: value });
  }
  expect(parseManifest("v: -0.0\n")).toMatchObject({ ok: false, line: 1 });
  expect(parseManifest("1.5: a\n")).toMatchObject({
    ok: false,
    line: 1,
    message: expect.stringContaining("float") as unknown,
  });
});

test("a merge whose result depends on where it stands is refused, and the usual one reads", () => {
  expect(parseManifest("a: &a {x: 1}\nv:\n  x: 9\n  <<: *a\n")).toMatchObject({
    ok: false,
    line: 4,
  });
  expect(
    parseManifest("a: &a {x: 1}\nb: &b {y: 2}\nv:\n  <<: *a\n  <<: *b\n"),
  ).toMatchObject({ ok: false, line: 5 });
  expect(objectOf("a: &a {x: 1}\nv:\n  <<: *a\n  x: 9\n")).toEqual({
    a: { x: 1 },
    v: { x: 9 },
  });
  expect(objectOf("a: &a {x: 1}\nv:\n  !!str <<: *a\n")).toEqual({
    a: { x: 1 },
    v: { "<<": { x: 1 } },
  });
});

test("what is one read in Go and another in the package is refused", () => {
  for (const text of [
    "%YAML 1.2\n---\nv: yes\n",
    "---\n---\na: 1\n",
    "v: {a:}\n",
    "v: [a?]\n",
    "'1': a\n1: b\n",
    "? a\n : b\n",
    "a: |\n  b\n  \n \t",
    "\ufeffa: 1\n\ufeffb: 2\n",
  ]) {
    expect(parseManifest(text).ok, JSON.stringify(text)).toBe(false);
  }
  expect(objectOf("v: |\n  a")).toEqual({ v: "a" });
  expect(objectOf("v: |\n  a\n")).toEqual({ v: "a\n" });
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

test("a number past 2^53 is written so that it reads back", () => {
  for (const value of [1e20, 2 ** 64, -(2 ** 60)]) {
    const text = yamlOfObject({ v: value });
    expect(text).toContain("e+");
    expect(parseManifest(text)).toEqual({ ok: true, object: { v: value } });
  }
  expect(yamlOfObject({ v: 2 ** 53 })).toBe("v: 9007199254740992\n");
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
