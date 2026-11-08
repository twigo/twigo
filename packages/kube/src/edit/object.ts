import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  LineCounter,
  parseAllDocuments,
  stringify,
  visit,
  type Document,
} from "yaml";

export type KubeObject = Record<string, unknown>;

/**
 * An object as YAML. It is YAML 1.1, which kubectl reads, so strings that
 * 1.1 would read as booleans, such as `"yes"` and `"on"`, stay quoted.
 */
export function yamlOfObject(value: unknown): string {
  return stringify(value, { version: "1.1" });
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

interface Problem {
  readonly message: string;
  /** Where in the text, from its start. */
  readonly offset: number;
}

/**
 * What the package's `toJS` throws on, found where it stands: an alias with
 * no anchor before it and a merge key that takes something else than maps.
 */
function unresolved(document: Document.Parsed): Problem | undefined {
  let found: Problem | undefined;
  const refuse = (node: unknown, message: string) => {
    found = {
      message,
      offset: (isNode(node) ? node.range?.[0] : undefined) ?? 0,
    };
    return visit.BREAK;
  };
  visit(document, {
    Alias: (_, alias) =>
      alias.resolve(document) === undefined
        ? refuse(alias, `The alias *${alias.source} has no anchor.`)
        : undefined,
    Pair: (_, { key, value }) => {
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
            isNode(source) ? source : key,
            "A merge key takes a map or a list of maps.",
          );
        }
      }
      return undefined;
    },
  });
  return found;
}

/**
 * The manifest as the one object it names. It reads YAML 1.1 like
 * `yamlOfObject` writes it, so there is one dialect, and Twigo previews one
 * object at a time: a second document is an error, not something left out.
 * Nothing here throws on the text; what cannot be read is an error at its
 * line.
 */
export function parseManifest(text: string): Parsed {
  const lines = new LineCounter();
  const documents = parseAllDocuments(text, {
    version: "1.1",
    lineCounter: lines,
  });
  const failed = (message: string, offset: number): Parsed => {
    const { line, col } = lines.linePos(offset);
    return { ok: false, message, line, column: col };
  };
  for (const document of documents) {
    const [error] = document.errors;
    if (error) {
      const [start] = error.pos;
      // The position goes beside the message, not in it.
      const message = (error.message.split("\n")[0] ?? error.message).replace(
        / at line \d+, column \d+:?$/,
        "",
      );
      return failed(message, start);
    }
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
  const refused = unresolved(first);
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
  // Through JSON, as the engine takes it: no dates or sets.
  return { ok: true, object: JSON.parse(JSON.stringify(object)) as KubeObject };
}

/** The lines of the top-level `status`, 1-based and inclusive; none when the text has no such block. */
export function statusLines(
  text: string,
): { readonly from: number; readonly to: number } | undefined {
  const lines = new LineCounter();
  const [document] = parseAllDocuments(text, {
    version: "1.1",
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
