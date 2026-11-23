import { describe, expect, test } from "vitest";
import type { HelmPart, ReleaseManifest } from "@twigo/protocol";
import HELM from "../../../protocol/src/mock/helm.json";
import { yamlOfJson, yamlOfObject } from "../edit/object";
import { documentsOf } from "./documents";
import {
  hiddenCount,
  manifestOf,
  partKey,
  spliced,
  valueGlyphs,
  type Shown,
} from "./reveals";

const shown = (...entries: Shown[]) =>
  new Map(entries.map((entry) => [partKey(entry.part), entry]));

const user = (...path: (string | number)[]): HelmPart => ({
  kind: "values",
  defaults: false,
  path,
});

const MASKED = JSON.stringify({
  database: { host: "<10 bytes>", password: "<16 bytes>" },
  extra: ["<3 bytes>", "<4 bytes>"],
  tls: true,
});

describe("values", () => {
  const text = yamlOfJson(MASKED);

  test("an eye on each masked line asks for the path the line stands at", () => {
    const glyphs = valueGlyphs(text, false, shown());
    expect(glyphs.map(({ part }) => part)).toEqual([
      user("database", "host"),
      user("database", "password"),
      user("extra", 0),
      user("extra", 1),
    ]);
    expect(glyphs.every(({ revealed }) => !revealed)).toBe(true);
    expect(hiddenCount(text)).toBe(4);
  });

  test("a revealed subtree is spliced where it came from, and its first line hides it", () => {
    const answer: Shown = {
      part: user("database"),
      value: '{"host":"db.example","password":"s3cret"}',
      binary: false,
    };
    const document = spliced(JSON.parse(MASKED), shown(answer));
    const next = yamlOfObject(document);
    expect(next).toContain("password: s3cret");
    expect(next).toContain("extra:\n  - <3 bytes>");
    const glyphs = valueGlyphs(next, false, shown(answer));
    expect(glyphs.filter(({ revealed }) => revealed)).toMatchObject([
      { line: 1, part: user("database") },
    ]);
    expect(glyphs.filter(({ revealed }) => !revealed)).toHaveLength(2);
    expect(hiddenCount(next)).toBe(2);
  });

  test("the whole document revealed replaces it, and a leaf of the other plate is another path", () => {
    const whole: Shown = {
      part: user(),
      value: '{"a":"clear"}',
      binary: false,
    };
    expect(spliced(JSON.parse(MASKED), shown(whole))).toEqual({ a: "clear" });
    const defaults: HelmPart = { kind: "values", defaults: true, path: ["a"] };
    const leaf: Shown = { part: defaults, value: '"x"', binary: false };
    expect(spliced({ a: "<1 bytes>" }, shown(leaf))).toEqual({ a: "x" });
    expect(valueGlyphs("a: x\n", false, shown(leaf))).toEqual([]);
    expect(
      valueGlyphs("a: x\n", true, shown(leaf)).map(({ revealed }) => revealed),
    ).toEqual([true]);
  });
});

describe("a manifest", () => {
  const recorded = HELM.releases[0]?.revisions[1]?.manifest as ReleaseManifest;

  test("an eye on each Secret's key and none on what is not a Secret", () => {
    const { text, glyphs } = manifestOf(recorded, shown());
    expect(text).toBe(recorded.text);
    expect(glyphs.map(({ part }) => part)).toEqual(
      ["token", "host", "password"].map((key) => ({
        kind: "secret",
        document: 0,
        items: [],
        key,
      })),
    );
    const lines = text.split("\n");
    for (const { line } of glyphs) expect(lines[line - 1]).toContain("bytes>");
  });

  test("a key revealed is written in its line, quoted where plain text would read as another thing", () => {
    const reveal = (key: string, value: string): Shown => ({
      part: { kind: "secret", document: 0, items: [], key },
      value,
      binary: false,
    });
    const { text, glyphs } = manifestOf(
      recorded,
      shown(reveal("password", "p: 1"), reveal("host", "db.example")),
    );
    expect(text).toContain('  password: "p: 1"');
    expect(text).toContain("  host: db.example");
    expect(glyphs.filter(({ revealed }) => revealed)).toHaveLength(2);
    expect(hiddenCount(text)).toBe(1);
  });

  test("a key that is not UTF-8 is written as its base64, with a comment that says so", () => {
    const binary: Shown = {
      part: { kind: "secret", document: 0, items: [], key: "token" },
      value: "AAEC/w==",
      binary: true,
    };
    const { text } = manifestOf(recorded, shown(binary));
    expect(text).toContain('  token: "AAEC/w==" # base64');
    expect(text).not.toContain("token: <");
  });

  test("an unread document revealed takes its place, and the eyes below it move with it", () => {
    const manifest: ReleaseManifest = {
      text: [
        "---",
        "# Source: a/unread.yaml",
        "Twigo could not read this document.",
        "",
        "---",
        "# Source: a/secret.yaml",
        "kind: Secret",
        "stringData:",
        "  token: <5 bytes>",
        "",
      ].join("\n"),
      secrets: [
        {
          document: 1,
          items: [],
          name: "s",
          namespace: null,
          line: 6,
          entries: [{ key: "token", bytes: 5, binary: false }],
        },
      ],
      unread: [{ document: 0, line: 2, source: "a/unread.yaml" }],
    };
    const document: Shown = {
      part: { kind: "document", document: 0 },
      value: "# Source: a/unread.yaml\nkind: ConfigMap\ndata:\n  a: b\n",
      binary: false,
    };
    const before = manifestOf(manifest, shown());
    expect(before.glyphs.map(({ line }) => line)).toEqual([2, 9]);
    expect(before.glyphs[0]?.label).toBe(
      "Reveal document 0 of the manifest (a/unread.yaml)",
    );
    const after = manifestOf(manifest, shown(document));
    expect(after.text).toContain("kind: ConfigMap\ndata:\n  a: b");
    expect(after.text).not.toContain("could not read");
    const eyes = after.glyphs.map(({ line, revealed }) => [line, revealed]);
    expect(eyes).toEqual([
      [2, true],
      [10, false],
    ]);
    expect(after.text.split("\n")[9]).toContain("token: <5 bytes>");
    expect(after.glyphs[0]?.label).toBe(
      "Hide document 0 of the manifest (a/unread.yaml)",
    );
  });
});

test("the documents of a manifest are listed by the file their Source comment names, as Helm splits them at its --- lines", () => {
  const text = [
    "---",
    "# Source: a/one.yaml",
    "kind: A",
    "---",
    "",
    "---",
    "kind: B",
    "---",
    "# Source: a/three.yaml",
    "kind: C",
  ].join("\n");
  expect(documentsOf(text)).toEqual([
    { name: "a/one.yaml", from: 2, to: 3 },
    { name: "Document 3", from: 7, to: 7 },
    { name: "a/three.yaml", from: 9, to: 10 },
  ]);
});

describe("a Secret inside a List's items", () => {
  const manifest: ReleaseManifest = {
    text: [
      "---",
      "# Source: a/list.yaml",
      "apiVersion: v1",
      "items:",
      "  - kind: Secret",
      "    metadata:",
      "      name: first",
      "    stringData:",
      "      token: <5 bytes>",
      "  - kind: Secret",
      "    metadata:",
      "      name: second",
      "    stringData:",
      "      token: <7 bytes>",
      "      other: <3 bytes>",
      "kind: List",
      "",
    ].join("\n"),
    secrets: [
      {
        document: 0,
        items: [0],
        name: "first",
        namespace: null,
        line: 2,
        entries: [{ key: "token", bytes: 5, binary: false }],
      },
      {
        document: 0,
        items: [1],
        name: "second",
        namespace: null,
        line: 2,
        entries: [
          { key: "token", bytes: 7, binary: false },
          { key: "other", bytes: 3, binary: false },
        ],
      },
    ],
    unread: [],
  };

  test("each item's keys have an eye on their own line, addressed through items", () => {
    const { glyphs } = manifestOf(manifest, shown());
    expect(glyphs.map(({ line, part }) => [line, part])).toEqual([
      [9, { kind: "secret", document: 0, items: [0], key: "token" }],
      [14, { kind: "secret", document: 0, items: [1], key: "token" }],
      [15, { kind: "secret", document: 0, items: [1], key: "other" }],
    ]);
  });

  test("a key revealed is written in its own item's line, and no other item's", () => {
    const answer: Shown = {
      part: { kind: "secret", document: 0, items: [1], key: "token" },
      value: "s3cret",
      binary: false,
    };
    const { text } = manifestOf(manifest, shown(answer));
    expect(text).toContain("      token: <5 bytes>");
    expect(text).toContain("      token: s3cret");
    expect(text).toContain("      other: <3 bytes>");
  });
});
