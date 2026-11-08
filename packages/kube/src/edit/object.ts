import {
  Document,
  isAlias,
  isCollection,
  isMap,
  isNode,
  isScalar,
  isSeq,
  LineCounter,
  parseAllDocuments,
  Scalar,
  visit,
  type DocumentOptions,
  type ParseOptions,
  type ScalarTag,
  type SchemaOptions,
  type Tags,
  type YAMLError,
} from "yaml";

export type KubeObject = Record<string, unknown>;

/**
 * An object as YAML. It is YAML 1.1, which kubectl reads, so strings that
 * 1.1 would read as booleans, such as `"yes"` and `"on"`, and as dates or
 * sexagesimal numbers, stay quoted, as does a key named `<<`, which would
 * merge.
 */
export function yamlOfObject(value: unknown): string {
  const document = new Document(value, {
    version: "1.1",
    // The merge tag would write the key `<<` as it is, whatever its type.
    customTags: (tags) =>
      kubectlIntegers(
        tags.filter((tag) => typeof tag === "string" || tag.tag !== MERGE_TAG),
      ),
  });
  visit(document, {
    Pair: (_, { key }) => {
      if (isScalar(key) && key.value === "<<") key.type = Scalar.QUOTE_DOUBLE;
    },
  });
  return document.toString();
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

const UNREAD_TAGS: ReadonlySet<string> = new Set([
  "tag:yaml.org,2002:binary",
  "tag:yaml.org,2002:omap",
  "tag:yaml.org,2002:pairs",
  "tag:yaml.org,2002:set",
  "tag:yaml.org,2002:timestamp",
]);

/** Go reads the prefixes of binary, octal and hex integers in either case; the package's 1.1 schema reads them in lower case only. */
const PREFIXED: Readonly<Record<string, RegExp>> = {
  BIN: /^[-+]?0[bB][01_]+$/,
  HEX: /^[-+]?0[xX][0-9a-fA-F_]+$/,
};

/** `0o777`, which go.yaml.in/yaml/v2 reads as an integer and the package's 1.1 schema does not. */
const OCTAL: ScalarTag = {
  tag: "tag:yaml.org,2002:int",
  default: true,
  format: "OCT",
  test: /^[-+]?0[oO][0-7_]+$/,
  resolve: (text) => {
    const number = BigInt(
      `0o${text.replace(/^[-+]?0[oO]/, "").replace(/_/g, "")}`,
    );
    return text.startsWith("-") ? -number : number;
  },
};

function read(tag: Tags[number]): Tags[number] {
  if (typeof tag === "string" || tag.collection !== undefined) return tag;
  const prefixed = tag.format === undefined ? undefined : PREFIXED[tag.format];
  if (prefixed) return { ...tag, test: prefixed };
  // A float too large for a double is a string to kubectl, not infinity.
  if (tag.tag !== "tag:yaml.org,2002:float" || tag.format !== "EXP") return tag;
  const bounded: ScalarTag = {
    ...tag,
    resolve: (text, onError, options) => {
      const value = tag.resolve(text, onError, options);
      return typeof value === "number" && !Number.isFinite(value)
        ? text
        : value;
    },
  };
  return bounded;
}

/** The package's tags with the integers and floats kubectl reads that it does not. */
function kubectlIntegers(tags: Tags): Tags {
  return [...tags.map(read), OCTAL];
}

/**
 * YAML as kubectl reads it (ARCHITECTURE 4.3): 1.1, as sigs.k8s.io/yaml
 * v1.6.0 over go.yaml.in/yaml/v2 v2.4.4 read it, which Kubernetes v1.37.0
 * pins. Dates, sexagesimal numbers, sets, ordered maps and binary are not
 * types there, so the package's tags for them go, and a tag that names one
 * is a warning that `parseManifest` refuses. Integers come as `bigint`, to
 * tell the ones JSON cannot carry exactly.
 */
const READING: ParseOptions & DocumentOptions & SchemaOptions = {
  version: "1.1",
  intAsBigInt: true,
  customTags: (tags) =>
    kubectlIntegers(
      tags.filter(
        (tag) =>
          typeof tag === "string" ||
          (!UNREAD_TAGS.has(tag.tag) && tag.format !== "TIME"),
      ),
    ),
};

/** The largest integer a double holds exactly, and so JSON carries through the IPC. */
const EXACT = 2n ** 53n;

interface Problem {
  readonly message: string;
  readonly offset: number;
}

/**
 * What kubectl reads and JSON, or the package's `toJS`, cannot say, found
 * where it stands. Integers within reach become numbers.
 */
function unreadable(document: Document.Parsed): Problem | undefined {
  let found: Problem | undefined;
  const refuse = (offset: number | undefined, message: string) => {
    found = { message, offset: offset ?? 0 };
    return visit.BREAK;
  };
  const start = (node: unknown) => (isNode(node) ? node.range?.[0] : undefined);
  visit(document, {
    Alias: (_, alias) =>
      alias.resolve(document) === undefined
        ? refuse(start(alias), `The alias *${alias.source} has no anchor.`)
        : undefined,
    Pair: (_, { key, value }) => {
      if (isCollection(key))
        return refuse(start(key), "A key must be a single value.");
      if (key === null || (isScalar(key) && key.value === null))
        return refuse(start(key), "A key cannot be empty.");
      if (
        !isScalar(key) ||
        typeof key.value !== "symbol" ||
        key.value.description !== "<<"
      )
        return undefined;
      for (const source of isSeq(value) ? value.items : [value]) {
        const merged = isAlias(source) ? source.resolve(document) : source;
        if (merged !== undefined && !isMap(merged)) {
          return refuse(
            start(source) ?? start(key),
            "A merge key takes a map or a list of maps.",
          );
        }
      }
      return undefined;
    },
    Scalar: (_, scalar) => {
      const { value } = scalar;
      if (typeof value === "bigint") {
        if (value > EXACT || value < -EXACT) {
          return refuse(
            start(scalar),
            `The integer ${String(value)} is past 2^53, which JSON cannot carry exactly.`,
          );
        }
        scalar.value = Number(value);
      } else if (typeof value === "number" && !Number.isFinite(value)) {
        return refuse(
          start(scalar),
          `${scalar.source ?? String(value)} is a number JSON cannot say.`,
        );
      }
      return undefined;
    },
  });
  return found;
}

function describe({ message }: YAMLError): string {
  const first = (message.split("\n")[0] ?? message).replace(
    / at line \d+, column \d+:?$/,
    "",
  );
  const tag = /^Unresolved tag: (.*)$/.exec(first)?.[1];
  return tag === undefined
    ? first
    : `Twigo does not read the tag ${tag.replace("tag:yaml.org,2002:", "!!")}`;
}

/**
 * The manifest as the one object it names. It reads YAML as kubectl does,
 * and `yamlOfObject` writes what it reads back, so there is one dialect.
 * Twigo previews one object at a time: a second document is an error, not
 * something left out. Nothing here throws on the text; what cannot be read
 * is an error at its line.
 */
export function parseManifest(text: string): Parsed {
  const lines = new LineCounter();
  const documents = parseAllDocuments(text, {
    ...READING,
    lineCounter: lines,
  });
  const failed = (message: string, offset: number): Parsed => {
    const { line, col } = lines.linePos(offset);
    return { ok: false, message, line, column: col };
  };
  for (const document of documents) {
    const [problem] = [...document.errors, ...document.warnings];
    if (problem) return failed(describe(problem), problem.pos[0]);
  }
  const filled = documents.filter(
    ({ contents }) =>
      contents !== null && !(isScalar(contents) && contents.value === null),
  );
  const [first, second] = filled;
  if (!first) return failed("The manifest is empty.", 0);
  if (second) {
    return failed(
      `The manifest has ${String(filled.length)} documents, and Twigo previews one object at a time.`,
      second.range[0],
    );
  }
  const refused = unreadable(first);
  if (refused) return failed(refused.message, refused.offset);
  let object: unknown;
  try {
    object = first.toJS();
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
  return { ok: true, object: JSON.parse(JSON.stringify(object)) as KubeObject };
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
