import type { HelmPart, ReleaseManifest, ValueStep } from "@twigo/protocol";
import { outlineOf, type Entry } from "../edit/outline";

/** A masked value as the core writes it: `<12 bytes>`, and `<12 bytes, changed>` in a comparison. */
export const MASK = /<\d+ bytes(?:, changed)?>/;

/** What a Reveal gave, by the part it answers. */
export interface Shown {
  readonly part: HelmPart;
  readonly value: string;
  readonly binary: boolean;
}

/** The key under which a Reveal's part is held. */
export const partKey = (part: HelmPart): string => JSON.stringify(part);

/** A line of a text and what the eye in its gutter asks of it: to reveal a masked value, or to hide a revealed one. */
export interface Glyph {
  readonly line: number;
  /** The last line of what the eye is about: its own for a hidden value, the end of the text revealed for a revealed one. */
  readonly to: number;
  readonly part: HelmPart;
  readonly revealed: boolean;
  /** What the eye says, for its tooltip and its name. */
  readonly label: string;
}

type Path = readonly ValueStep[];

const stepLabel = (step: ValueStep): string =>
  typeof step === "number" ? `[${String(step)}]` : step;

const pathLabel = (path: Path): string =>
  path.reduce<string>(
    (text, step) =>
      typeof step === "number"
        ? `${text}[${String(step)}]`
        : text === ""
          ? step
          : `${text}.${step}`,
    "",
  );

/** A path of the YAML outline as the steps of the values: `[3]` is the index 3. */
function stepsOf(labels: readonly string[]): Path {
  return labels.flatMap((label): ValueStep[] => {
    const items = /^(.*?)((?:\[\d+\])+)$/.exec(label);
    if (!items) return [label];
    const [, key = "", indexes = ""] = items;
    return [
      ...(key === "" ? [] : [key]),
      ...[...indexes.matchAll(/\[(\d+)\]/g)].map(([, n]) => Number(n)),
    ];
  });
}

/** The values with each revealed subtree put where it came from. */
export function spliced(
  masked: unknown,
  shown: ReadonlyMap<string, Shown>,
): unknown {
  const reveals = [...shown.values()]
    .flatMap(({ part, value }) =>
      part.kind === "values" ? [{ path: part.path, value }] : [],
    )
    .sort((a, b) => a.path.length - b.path.length);
  let document = masked;
  for (const { path, value } of reveals) {
    document = put(document, path, JSON.parse(value) as unknown);
  }
  return document;
}

function put(node: unknown, path: Path, value: unknown): unknown {
  const [step, ...rest] = path;
  if (step === undefined) return value;
  if (Array.isArray(node) && typeof step === "number") {
    return node.map((item: unknown, index) =>
      index === step ? put(item, rest, value) : item,
    );
  }
  if (typeof node === "object" && node !== null && typeof step === "string") {
    return Object.fromEntries(
      Object.entries(node).map(([key, item]) => [
        key,
        key === step ? put(item, rest, value) : item,
      ]),
    );
  }
  return node;
}

function entryAt(
  entries: readonly Entry[],
  path: Path,
): { entry: Entry; step: number } | undefined {
  let level = entries;
  let found: Entry | undefined;
  for (const step of path) {
    found = level.find(({ label }) => label === stepLabel(step));
    if (!found) return undefined;
    level = found.entries;
  }
  return found && { entry: found, step: path.length };
}

/**
 * The eyes of a values text: one on each line that holds a masked value, which
 * reveals the path the line stands at, and one on the first line of each
 * subtree that was revealed, which hides it.
 */
export function valueGlyphs(
  text: string,
  defaults: boolean,
  shown: ReadonlyMap<string, Shown>,
): readonly Glyph[] {
  const outline = outlineOf(text);
  const lines = text.split("\n");
  const glyphs: Glyph[] = [];
  for (const { part } of shown.values()) {
    if (part.kind !== "values" || part.defaults !== defaults) continue;
    const at = entryAt(outline, part.path);
    glyphs.push({
      line: at ? at.entry.from : 1,
      to: at ? at.entry.to : lines.length,
      part,
      revealed: true,
      label: `Hide ${part.path.length === 0 ? "the values" : pathLabel(part.path)}`,
    });
  }
  lines.forEach((content, index) => {
    if (!MASK.test(content)) return;
    const line = index + 1;
    const path = stepsOf(pathAtLine(outline, line));
    const part: HelmPart = { kind: "values", defaults, path: [...path] };
    glyphs.push({
      line,
      to: line,
      part,
      revealed: false,
      label: `Reveal ${path.length === 0 ? "the values" : pathLabel(path)}`,
    });
  });
  return glyphs;
}

function pathAtLine(outline: readonly Entry[], line: number): string[] {
  const covers = ({ from, to }: Entry) => from <= line && line <= to;
  const path: string[] = [];
  for (let hit = outline.find(covers); hit; hit = hit.entries.find(covers)) {
    const parent = hit.key === undefined ? path.pop() : undefined;
    path.push(`${parent ?? ""}${hit.label}`);
  }
  return path;
}

export function hiddenWords(count: number): string {
  return count === 0
    ? "No value is hidden"
    : `${String(count)} ${count === 1 ? "value" : "values"} hidden`;
}

/** The masked values of a text: what `12 values hidden` counts. */
export function hiddenCount(text: string): number {
  return text.split("\n").filter((line) => MASK.test(line)).length;
}

/** A value as YAML writes a plain scalar, or in JSON's quotes where it would read as something else. */
function scalar(value: string): string {
  return /^[A-Za-z0-9_./@+-][A-Za-z0-9_./@+ -]*$/.test(value) &&
    !/^(true|false|null|yes|no|on|off|~|[-+]?[0-9.]+)$/i.test(value) &&
    !value.endsWith(" ")
    ? value
    : JSON.stringify(value);
}

const indentOf = (line: string): number => /^ */.exec(line)?.[0].length ?? 0;

/**
 * The lines of the item a path through `items` names, inside the lines of a
 * document: each step finds the `items:` of what it stands in, then the
 * dashes at the indent of its first line, and takes the one at the step.
 */
function itemRange(
  lines: readonly string[],
  from: number,
  to: number,
  items: readonly number[],
): readonly [number, number] | undefined {
  let start = from;
  let limit = to;
  for (const index of items) {
    const at = lines.findIndex(
      (line, i) => i >= start && i < limit && /^\s*items:\s*$/.test(line),
    );
    if (at < 0) return undefined;
    const indent = indentOf(lines[at + 1] ?? "");
    const dash = new RegExp(`^ {${String(indent)}}- `);
    const starts: number[] = [];
    let stop = limit;
    for (let i = at + 1; i < limit; i++) {
      const line = lines[i] ?? "";
      if (line.trim() !== "" && indentOf(line) < indent) {
        stop = i;
        break;
      }
      if (dash.test(line)) starts.push(i);
    }
    const first = starts[index];
    if (first === undefined) return undefined;
    start = first;
    limit = starts[index + 1] ?? stop;
  }
  return [start, limit];
}

/** What Reveal All asks of a manifest: the whole of it, whose answer is the view's text until Hide All. */
export const WHOLE_MANIFEST: HelmPart = { kind: "manifest" };

/** A manifest that Reveal All showed whole, which is revealed from its first line to its last with the one eye that hides it, as the whole values are. */
export function manifestRevealed(text: string): {
  text: string;
  glyphs: readonly Glyph[];
} {
  return {
    text,
    glyphs: [
      {
        line: 1,
        to: text.split("\n").length,
        part: WHOLE_MANIFEST,
        revealed: true,
        label: "Hide the manifest",
      },
    ],
  };
}

/**
 * A manifest with what was revealed put in place, and the eyes of its lines.
 * A Secret's key is the line `key: <N bytes>` in the document the core gives
 * a line to, which a value that is not UTF-8 replaces with its base64 and a
 * comment saying so; a document that could not be read is the lines from its
 * own to the next `---`, which a Reveal of it replaces by the document whole.
 */
export function manifestOf(
  manifest: ReleaseManifest,
  shown: ReadonlyMap<string, Shown>,
): { text: string; glyphs: readonly Glyph[] } {
  const lines = manifest.text.split("\n");
  const end = (from: number): number => {
    const next = lines.findIndex(
      (line, index) => index >= from && /^---[ \t]*$/.test(line),
    );
    return next < 0 ? lines.length : next;
  };
  type Edit =
    | { kind: "key"; line: number; part: HelmPart; key: string; name: string }
    | { kind: "document"; line: number; part: HelmPart; name: string };
  const edits: Edit[] = [];
  for (const secret of manifest.secrets) {
    const document = secret.line - 1;
    const range =
      secret.items.length === 0
        ? ([document, end(document)] as const)
        : itemRange(lines, document, end(document), secret.items);
    if (!range) continue;
    const [from, to] = range;
    for (const { key } of secret.entries) {
      const found = lines
        .slice(from, to)
        .findIndex(
          (line) => line.trimStart().startsWith(`${key}:`) && MASK.test(line),
        );
      const line = found < 0 ? undefined : from + found + 1;
      if (line === undefined) continue;
      edits.push({
        kind: "key",
        line,
        key,
        part: {
          kind: "secret",
          document: secret.document,
          items: [...secret.items],
          key,
        },
        name: `${key} of ${secret.name}`,
      });
    }
  }
  for (const { document, line, source } of manifest.unread) {
    edits.push({
      kind: "document",
      line,
      part: { kind: "document", document },
      name:
        source === null
          ? `document ${String(document + 1)} in the manifest`
          : `the document ${source} in the manifest`,
    });
  }
  edits.sort((a, b) => b.line - a.line);
  const glyphs: { line: number; glyph: Omit<Glyph, "line"> }[] = [];
  for (const edit of edits) {
    const value = shown.get(partKey(edit.part));
    const at = edit.line - 1;
    if (value === undefined) {
      glyphs.push({
        line: edit.line,
        glyph: {
          to: edit.line,
          part: edit.part,
          revealed: false,
          label: `Reveal ${edit.name}`,
        },
      });
      continue;
    }
    let delta = 0;
    let last = edit.line;
    if (edit.kind === "key") {
      const row = lines[at] ?? "";
      lines[at] = row.replace(
        MASK,
        `${scalar(value.value)}${value.binary ? " # base64" : ""}`,
      );
    } else {
      const replaced = end(at + 1) - at;
      const text = value.value.replace(/\n$/, "").split("\n");
      lines.splice(at, replaced, ...text);
      delta = text.length - replaced;
      last = edit.line + text.length - 1;
    }
    if (delta !== 0) {
      for (const each of glyphs) {
        if (each.line <= edit.line) continue;
        each.line += delta;
        each.glyph = { ...each.glyph, to: each.glyph.to + delta };
      }
    }
    glyphs.push({
      line: edit.line,
      glyph: {
        to: last,
        part: edit.part,
        revealed: true,
        label: `Hide ${edit.name}`,
      },
    });
  }
  return {
    text: lines.join("\n"),
    glyphs: glyphs
      .map(({ line, glyph }) => ({ line, ...glyph }))
      .sort((a, b) => a.line - b.line),
  };
}
