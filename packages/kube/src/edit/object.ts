import {
  Composer,
  CST,
  Document,
  isAlias,
  isCollection,
  isMap,
  isNode,
  isScalar,
  isSeq,
  LineCounter,
  parseAllDocuments,
  Parser,
  Scalar,
  visit,
  type DocumentOptions,
  type ParseOptions,
  type Range,
  type SchemaOptions,
  type Tags,
  type YAMLMap,
} from "yaml";

export type KubeObject = Record<string, unknown>;

/** Characters Go refuses, reads as line breaks, or takes as a byte-order mark in the wrong place; `\r` alone is one too. */
const CHARACTER =
  "[^\\t\\n\\r\\x20-\\x7e\\xa0-\\u2027\\u202a-\\ud7ff\\ue000-\\ufefe\\uff00-\\ufffd\\u{10000}-\\u{10ffff}]";
const UNREADABLE = new RegExp(`(?!^\\ufeff)${CHARACTER}|\\r(?!\\n)`, "u");
const UNWRITABLE = new RegExp(`${CHARACTER}|\\r`, "u");

/** A line the block form cannot carry: Go refuses a tab that starts a line of one, and a line of spaces does not read back. */
const UNBLOCKABLE = /^ *\t|^ +$/m;

/** Whether a string goes in double quotes: what would read as a number, a merge or a line of its own is safe nowhere else. */
function needsQuotes(text: string): boolean {
  return (
    UNWRITABLE.test(text) ||
    goNumber(text) !== undefined ||
    text === "<<" ||
    (text.includes("\n") && (text.startsWith("\n") || UNBLOCKABLE.test(text)))
  );
}

/**
 * An object as YAML. It is YAML 1.1, which kubectl reads, and what it writes
 * reads back equal in `parseManifest` and in Go: strings either would read as
 * something else are quoted, as are a key named `<<`, which would merge, and
 * strings with a character neither carries raw, which go in double quotes
 * with that character escaped. An integer past 2^53 goes as an exponent, since
 * JSON has already rounded it and `parseManifest` refuses a longer one.
 */
export function yamlOfObject(value: unknown): string {
  const document = new Document(value, {
    version: "1.1",
    // The merge tag would write the key `<<` as it is, whatever its type.
    customTags: (tags) =>
      tags.filter((tag) => typeof tag === "string" || tag.tag !== MERGE_TAG),
  });
  visit(document, {
    Scalar: (_, scalar) => {
      if (typeof scalar.value === "string" && needsQuotes(scalar.value)) {
        scalar.type = Scalar.QUOTE_DOUBLE;
      } else if (
        typeof scalar.value === "number" &&
        Number.isInteger(scalar.value) &&
        Math.abs(scalar.value) > Number(EXACT)
      ) {
        scalar.format = "EXP";
      }
    },
  });
  return document
    .toString({ lineWidth: 0, doubleQuotedAsJSON: true })
    .replace(
      /[\x7f-\x9f\u2028\u2029\ufeff\ufffe\uffff]/g,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
}

export function yamlOfJson(json: string): string {
  return yamlOfObject(JSON.parse(json));
}

export type Parsed =
  | { readonly ok: true; readonly object: KubeObject }
  | {
      readonly ok: false;
      readonly message: string;
      /** 1-based, where the text goes wrong. */
      readonly line: number;
      readonly column: number;
    };

const MERGE_TAG = "tag:yaml.org,2002:merge";
const STR_TAG = "tag:yaml.org,2002:str";

const UNREAD_TAGS: ReadonlySet<string> = new Set([
  "tag:yaml.org,2002:binary",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:omap",
  "tag:yaml.org,2002:pairs",
  "tag:yaml.org,2002:set",
  "tag:yaml.org,2002:timestamp",
]);

/** `resolve` in go.yaml.in/yaml/v2: a bigint for an integer, a number for a float, nothing for the strings Go reads. */
function goNumber(text: string): bigint | number | undefined {
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(text)) {
    return text.startsWith("-") ? -Infinity : Infinity;
  }
  if (/^\.(?:nan|NaN|NAN)$/.test(text)) return NaN;
  if (text.startsWith(".")) {
    return /^\.[0-9](?:_?[0-9])*(?:[eE][-+]?[0-9](?:_?[0-9])*)?$/.test(text)
      ? finite(Number(text.replace(/_/g, "")))
      : undefined;
  }
  if (!/^[-+0-9]/.test(text)) return undefined;
  const plain = text.replace(/_/g, "");
  const integer =
    /^([-+]?)(0[bB][01]+|0[oO][0-7]+|0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/.exec(
      plain,
    );
  if (integer) {
    const digits = integer[2] ?? "";
    const value = BigInt(
      /^0[0-7]/.test(digits) ? `0o${digits.slice(1)}` : digits,
    );
    return integer[1] === "-" ? -value : value;
  }
  // Go retries a `0b` prefix with the digits alone, so that a sign may follow it.
  const signedBinary = /^0b([-+])([01]+)$/.exec(plain);
  if (signedBinary) {
    const value = BigInt(`0b${signedBinary[2] ?? ""}`);
    return signedBinary[1] === "-" ? -value : value;
  }
  return /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(plain)
    ? finite(Number(plain))
    : undefined;
}

function finite(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

/**
 * YAML as kubectl reads it (ARCHITECTURE 4.3): 1.1, as sigs.k8s.io/yaml
 * v1.6.0 over go.yaml.in/yaml/v2 v2.4.4 read it, which Kubernetes v1.37.0
 * pins. Dates, sexagesimal numbers, sets, ordered maps and binary are not
 * types there, so the package's tags for them go, and a tag that names one
 * is a warning that `parseManifest` refuses. Numbers are the package's tags
 * no more: Go's rules for them differ too widely, so `goNumber` reads plain
 * scalars itself and these read as text until then.
 */
const READING: ParseOptions & DocumentOptions & SchemaOptions = {
  version: "1.1",
  uniqueKeys: false,
  customTags: (tags: Tags) =>
    tags.filter(
      (tag) =>
        typeof tag === "string" ||
        (!UNREAD_TAGS.has(tag.tag) && tag.format !== "TIME"),
    ),
};

/** The largest integer a double holds exactly, and so JSON carries through the IPC. */
const EXACT = 2n ** 53n;

interface Problem {
  readonly message: string;
  readonly offset: number;
}

interface MapProblem {
  readonly node: unknown;
  readonly message: string;
}

const ANCHOR = /^[0-9A-Za-z_-]+$/;

function isMergeKey(key: unknown): key is Scalar {
  return (
    isScalar(key) &&
    ((typeof key.value === "symbol" && key.value.description === "<<") ||
      (key.type === Scalar.PLAIN && key.value === "<<"))
  );
}

/**
 * The manifest's scalars as Go resolves them, numbers by `goNumber`, and what
 * kubectl reads and JSON, or the package's `toJS`, cannot say, found where
 * it stands.
 */
function unreadable(
  document: Document.Parsed,
  text: string,
): Problem | undefined {
  const start = (node: unknown) => (isNode(node) ? node.range?.[0] : undefined);
  visit(document, {
    Scalar: (_, scalar) => {
      if (scalar.type !== Scalar.PLAIN || scalar.tag !== undefined) {
        // `!!str <<` is the key `<<` to Go, and the package would merge it.
        if (scalar.tag === STR_TAG && scalar.source === "<<") {
          scalar.type = Scalar.QUOTE_SINGLE;
        }
        return;
      }
      const number = goNumber(scalar.source ?? "");
      if (number !== undefined) scalar.value = number;
    },
  });
  let found: Problem | undefined;
  const problem = (): Problem | undefined => found;
  const refuse = (node: unknown, message: string) => {
    found = { message, offset: start(node) ?? 0 };
    return visit.BREAK;
  };
  const anchor = (node: { anchor?: string; range?: Range | null }) =>
    node.anchor === undefined || ANCHOR.test(node.anchor)
      ? undefined
      : refuse(node, `Kubectl refuses the anchor &${node.anchor}.`);
  visit(document, {
    Alias: (_, alias, path) => {
      const target = alias.resolve(document);
      if (target === undefined) {
        return refuse(alias, `The alias *${alias.source} has no anchor.`);
      }
      return path.includes(target)
        ? refuse(alias, `The anchor ${alias.source} contains itself.`)
        : undefined;
    },
    Collection: (_, collection) => anchor(collection),
    Scalar: (_, scalar) => anchor(scalar),
  });
  if (problem()) return problem();
  const resolved = (node: unknown) =>
    isAlias(node) ? node.resolve(document) : node;
  const tabbedIndicator = (offset: number | undefined): boolean => {
    if (offset === undefined) return false;
    const prefix = text.slice(text.lastIndexOf("\n", offset) + 1, offset);
    return prefix.includes("\t") && /^[ ]*(?:[-?:][ \t]*)+$/.test(prefix);
  };
  const flowing = (path: readonly unknown[]) =>
    path.some((node) => isCollection(node) && node.flow === true);
  const keyOf = (key: unknown): { name: string; type: string } => {
    const value = resolved(key);
    return isScalar(value)
      ? { name: String(value.value), type: typeof value.value }
      : { name: "", type: "" };
  };
  const merged = (node: unknown): { name: string; type: string }[] => {
    const source = resolved(node);
    if (isSeq(source)) return source.items.flatMap(merged);
    if (!isMap(source)) return [];
    return source.items.flatMap(({ key, value }) =>
      isMergeKey(key) ? merged(value) : [keyOf(key)],
    );
  };
  const mapProblem = (map: YAMLMap): MapProblem | undefined => {
    const seen = new Set<string>();
    // Go keeps a merged key beside one of another type that JSON names the
    // same, and which of them reaches JSON changes from one read to the next.
    const mergedTypes = new Map<string, string>();
    const collides = (name: string, type: string) =>
      (mergedTypes.get(name) ?? type) !== type;
    const collision = (node: unknown, name: string): MapProblem => ({
      node,
      message: `The key ${name} and one of another type that JSON names the same come out in no fixed order; quote them alike.`,
    });
    let merging = false;
    for (const { key, value } of map.items) {
      if (tabbedIndicator(start(key)) || tabbedIndicator(start(value))) {
        return {
          node: key ?? value,
          message: "Kubectl refuses a tab after this indicator.",
        };
      }
      const scalar = resolved(key);
      if (isCollection(scalar)) {
        return { node: key, message: "A key must be a single value." };
      }
      if (
        key === null ||
        (isScalar(scalar) &&
          (scalar.value === null ||
            (scalar.value === "" && scalar.type === Scalar.PLAIN)))
      ) {
        return { node: key ?? map, message: "A key cannot be empty." };
      }
      if (
        map.flow === true &&
        isScalar(key) &&
        key.type === Scalar.PLAIN &&
        key.range &&
        /^[ \t]*:[,[\]{}?]/.test(text.slice(key.range[1]))
      ) {
        return {
          node: key,
          message:
            "Kubectl reads this key and its colon as one text; quote the key or give it a value.",
        };
      }
      if (isScalar(scalar) && typeof scalar.value === "number") {
        return {
          node: key,
          message: `The key ${scalar.source ?? String(scalar.value)} is a float, which kubectl names differently; quote it.`,
        };
      }
      if (isMergeKey(scalar)) {
        if (merging) {
          return {
            node: key,
            message:
              "A mapping takes one merge key: kubectl takes the last of several.",
          };
        }
        merging = true;
        for (const source of isSeq(value) ? value.items : [value]) {
          const target = resolved(source);
          if (target !== undefined && !isMap(target)) {
            return {
              node: source ?? key,
              message: "A merge key takes a map or a list of maps.",
            };
          }
        }
        for (const { name, type } of merged(value)) {
          if (seen.has(name)) {
            return {
              node: key,
              message: `The key ${name} is set before the merge that also sets it, and kubectl takes the merge's.`,
            };
          }
          if (collides(name, type)) return collision(key, name);
          mergedTypes.set(name, type);
        }
        continue;
      }
      const { name, type } = keyOf(key);
      if (seen.has(name)) {
        return {
          node: key,
          message: `Map keys must be unique: ${name} is set twice.`,
        };
      }
      if (collides(name, type)) return collision(key, name);
      seen.add(name);
    }
    return undefined;
  };
  visit(document, {
    Seq: (_, seq) => {
      const tabbed = seq.items.find((item) => tabbedIndicator(start(item)));
      return tabbed
        ? refuse(tabbed, "Kubectl refuses a tab after this indicator.")
        : undefined;
    },
    Map: (_, map) => {
      const problem = mapProblem(map);
      return problem ? refuse(problem.node, problem.message) : undefined;
    },
    Scalar: (_, scalar, path) => {
      const raw =
        scalar.range === undefined || scalar.range === null
          ? ""
          : text.slice(scalar.range[0], scalar.range[1]);
      if (scalar.type === Scalar.QUOTE_DOUBLE && goRefusesEscape(raw)) {
        return refuse(
          scalar,
          "Kubectl reads an escape in this string otherwise, or refuses it.",
        );
      }
      if (
        scalar.type === Scalar.BLOCK_LITERAL ||
        scalar.type === Scalar.BLOCK_FOLDED
      ) {
        const atEnd =
          /^ *$/.test(text.slice(scalar.range?.[1] ?? text.length)) &&
          !text.endsWith("\n");
        if (blockGoReadsOtherwise(text, scalar.range?.[0] ?? 0, atEnd)) {
          return refuse(
            scalar,
            "Kubectl reads the lines of spaces in this block scalar otherwise; remove them or end the text with a line break.",
          );
        }
        // The package ends a block scalar at the end of the text with a line break; Go, as the text does.
        if (atEnd && typeof scalar.value === "string") {
          scalar.value = scalar.value.replace(/\n$/, "");
        }
      }
      if (scalar.type === Scalar.PLAIN && flowing(path) && unreadInFlow(raw)) {
        return refuse(
          scalar,
          "Kubectl reads this text differently inside [ ] or { }; quote it.",
        );
      }
      const { value } = scalar;
      if (typeof value === "bigint" && (value > EXACT || value < -EXACT)) {
        return refuse(
          scalar,
          `The integer ${String(value)} is past 2^53, which JSON cannot carry exactly.`,
        );
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        return refuse(
          scalar,
          `${scalar.source ?? String(value)} is a number JSON cannot say.`,
        );
      }
      return Object.is(value, -0)
        ? refuse(scalar, "Negative zero is a number JSON cannot say.")
        : undefined;
    },
  });
  if (problem()) return problem();
  // Last, since the checks above tell an integer key from a float one by this.
  visit(document, {
    Scalar: (_, scalar) => {
      if (typeof scalar.value === "bigint") {
        scalar.value = Number(scalar.value);
      }
    },
  });
  return undefined;
}

/** Whether a block scalar, as written, is one where lines of spaces read otherwise in Go: with an indentation indicator, or ending the text without a line break. */
function blockGoReadsOtherwise(
  text: string,
  start: number,
  atEnd: boolean,
): boolean {
  const newline = text.indexOf("\n", start);
  const header = text.slice(start, newline < 0 ? text.length : newline);
  if (!/^[|>][-+0-9]*[ \t]*(?:#.*)?\r?$/.test(header)) return true;
  if (
    /^[|>][-+]*\d/.test(header) &&
    /^ +\r?$/m.test(text.slice(start + header.length))
  ) {
    return true;
  }
  return atEnd && /\n +$/.test(text);
}

/** Whether a plain scalar inside `[ ]` or `{ }` is one Go's scanner cuts or refuses and the package reads whole. */
function unreadInFlow(raw: string): boolean {
  return raw.includes("\n") || raw.includes("?") || raw.startsWith(":");
}

/** Whether a double-quoted scalar, as written, holds an escape the package takes and Go's scanner refuses or reads otherwise: `\\/`, a code point that is no character, an escaped line break, or no closing quote at all. */
function goRefusesEscape(raw: string): boolean {
  if (!/^"(?:[^"\\]|\\[\s\S])*"$/.test(raw)) return true;
  for (const [, escape = ""] of raw.matchAll(
    /\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g,
  )) {
    if (escape === "/" || escape === "\n" || escape === "\r") return true;
    if (escape.length > 1) {
      const code = Number.parseInt(escape.slice(1), 16);
      if ((code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return true;
    }
  }
  return false;
}

/**
 * A block mapping's key that only the package reads: an implicit key whose
 * colon is not on its line, and a `?` whose `:` is not in its column, which
 * Go's scanner refuses.
 */
function looseKey(
  tokens: readonly CST.Token[],
  lines: LineCounter,
): Problem | undefined {
  let found: Problem | undefined;
  for (const token of tokens) {
    if (token.type !== "document") continue;
    CST.visit(token, (item, path) => {
      if (path.length === 0) return undefined;
      const collection = CST.visit.parentCollection(token, path).type;
      const block = collection === "block-map";
      if (!block && collection !== "flow-collection") return undefined;
      const explicit = item.start.find(
        ({ type }) => type === "explicit-key-ind",
      );
      const colon = item.sep?.find(({ type }) => type === "map-value-ind");
      if (explicit) {
        if (
          block &&
          (colon === undefined ||
            lines.linePos(colon.offset).col !==
              lines.linePos(explicit.offset).col)
        ) {
          found = {
            message:
              "A ? key needs its : on a line of its own, in the same column.",
            offset: explicit.offset,
          };
          return CST.visit.BREAK;
        }
        return undefined;
      }
      if (item.key && "source" in item.key && item.key.source.includes("\n")) {
        found = {
          message: "Kubectl refuses a key that spans lines.",
          offset: item.key.offset,
        };
        return CST.visit.BREAK;
      }
      const colonIndex = item.sep?.findIndex(
        ({ type }) => type === "map-value-ind",
      );
      if (
        colonIndex !== undefined &&
        colonIndex >= 0 &&
        item.sep?.slice(0, colonIndex).some(({ type }) => type === "newline") &&
        item.key
      ) {
        found = {
          message: "Kubectl refuses a key whose : is not on its line.",
          offset: item.key.offset,
        };
        return CST.visit.BREAK;
      }
      return undefined;
    });
    if (found) return found;
  }
  return found;
}

function describe(message: string): string {
  const tag = /^Unresolved tag: (.*)$/.exec(message)?.[1];
  return tag === undefined
    ? message
    : `Twigo does not read the tag ${tag.replace("tag:yaml.org,2002:", "!!")}`;
}

/**
 * The manifest as the one object it names. It reads YAML as Go does
 * (ARCHITECTURE 4.3), so that every text either reads as kubectl reads it or
 * is refused here as a parse error at its line, and `yamlOfObject` writes
 * what it reads back, so there is one dialect. Twigo previews one object at a
 * time: a second document is an error, not something left out. Nothing here
 * throws on the text; what cannot be read is an error at its line.
 */
export function parseManifest(text: string): Parsed {
  const lines = new LineCounter();
  const tokens = [...new Parser(lines.addNewLine).parse(text)];
  const failed = (message: string, offset: number): Parsed => {
    const { line, col } = lines.linePos(offset);
    return { ok: false, message, line, column: col };
  };
  const character = UNREADABLE.exec(text);
  if (character) {
    return failed(
      `Kubectl does not read U+${(character[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")} here; a double-quoted escape does.`,
      character.index,
    );
  }
  const tab = /^ *\t/m.exec(text);
  if (tab) {
    return failed(
      "Kubectl refuses a tab at the start of a line.",
      tab.index + tab[0].length - 1,
    );
  }
  const directive = tokens.find(({ type }) => type === "directive");
  if (directive) {
    return failed("Twigo does not read YAML directives.", directive.offset);
  }
  const keyed = looseKey(tokens, lines);
  if (keyed) return failed(keyed.message, keyed.offset);
  const documents = Array.from(
    new Composer(READING).compose(tokens, true, text.length),
  );
  for (const document of documents) {
    const [problem] = [...document.errors, ...document.warnings];
    if (problem) return failed(describe(problem.message), problem.pos[0]);
  }
  const isFilled = ({ contents }: Document.Parsed) =>
    contents !== null && !(isScalar(contents) && contents.value === null);
  const filled = documents.filter(isFilled);
  const [first, second] = filled;
  if (!first) return failed("The manifest is empty.", 0);
  if (second) {
    return failed(
      `The manifest has ${String(filled.length)} documents, and Twigo previews one object at a time.`,
      second.range[0],
    );
  }
  if (documents[0] !== first) {
    return failed(
      "An empty document stands before the object; remove it.",
      first.range[0],
    );
  }
  const refused = unreadable(first, text);
  if (refused) return failed(refused.message, refused.offset);
  let object: unknown;
  try {
    object = JSON.parse(JSON.stringify(first.toJS()));
  } catch (error) {
    // Aliases that expand past the package's limit, which no walk of the tree sees.
    return failed(
      error instanceof Error ? error.message : String(error),
      first.range[0],
    );
  }
  if (typeof object !== "object" || object === null || Array.isArray(object)) {
    return failed(
      "The manifest must be the fields of one object.",
      first.range[0],
    );
  }
  return { ok: true, object: object as KubeObject };
}

/** The lines of the top-level `status`, 1-based and inclusive; none when the text has no such block. */
export function statusLines(
  text: string,
): { readonly from: number; readonly to: number } | undefined {
  const lines = new LineCounter();
  const [document] = parseAllDocuments(text, {
    ...READING,
    lineCounter: lines,
  });
  const root = document?.contents;
  if (!isMap(root)) return undefined;
  const pair = root.items.find(
    ({ key }) => isScalar(key) && key.value === "status",
  );
  if (!pair || !isScalar(pair.key)) return undefined;
  const start = pair.key.range[0];
  const end = isNode(pair.value) ? pair.value.range[1] : pair.key.range[1];
  return {
    from: lines.linePos(start).line,
    to: lines.linePos(Math.max(start, end - 1)).line,
  };
}

export function kindOf(object: unknown):
  | {
      readonly group: string;
      readonly version: string;
      readonly kind: string;
    }
  | undefined {
  if (typeof object !== "object" || object === null) return undefined;
  const { apiVersion, kind } = object as Record<string, unknown>;
  if (typeof apiVersion !== "string" || typeof kind !== "string")
    return undefined;
  const slash = apiVersion.lastIndexOf("/");
  return {
    group: slash < 0 ? "" : apiVersion.slice(0, slash),
    version: apiVersion.slice(slash + 1),
    kind,
  };
}

export function resourceVersionOf(json: string): string | undefined {
  const { metadata } = JSON.parse(json) as { metadata?: KubeObject };
  const version = metadata?.resourceVersion;
  return typeof version === "string" ? version : undefined;
}

/**
 * An object as two writes of it compare: without what only moves the
 * version. A status write moves `resourceVersion` and `generation` and
 * changes `status`, so where the resource has a `status` subresource, which
 * the person edits no part of, only the rest says that the object changed
 * (ARCHITECTURE 6.5); elsewhere `status` is an ordinary field.
 */
export function comparable(json: string, statusSubresource: boolean): string {
  const object = JSON.parse(json) as KubeObject;
  const { metadata, status, ...rest } = object;
  const kept = {
    ...rest,
    ...(!statusSubresource && status !== undefined && { status }),
    ...(isRecord(metadata) && {
      metadata: Object.fromEntries(
        Object.entries(metadata).filter(
          ([key]) => key !== "resourceVersion" && key !== "generation",
        ),
      ),
    }),
  };
  return JSON.stringify(sorted(kept));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key])]),
  );
}
