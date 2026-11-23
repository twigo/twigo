import { useMemo } from "react";
import type { HelmPart, ValueStep } from "@twigo/protocol";
import { Tree, type TreeRow } from "@twigo/ui";
import { useListRegistration } from "@twigo/workbench";
import { formatBytes } from "@twigo/utils";
import { RevealButton } from "../object/RevealButton";
import { MASK, partKey, type Glyph, type Shown } from "./reveals";

interface Row {
  readonly path: readonly ValueStep[];
  readonly parent: string | undefined;
  readonly depth: number;
  readonly label: string;
  /** A leaf's text; none for a map or a list. */
  readonly text: string | undefined;
  /** Whether a masked value stands in this row or under it. */
  readonly masked: boolean;
}

const idOf = (path: readonly ValueStep[]): string => JSON.stringify(path);

function textOf(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function holdsMask(value: unknown): boolean {
  if (typeof value === "string") return MASK.test(value);
  if (Array.isArray(value)) return value.some(holdsMask);
  if (typeof value === "object" && value !== null)
    return Object.values(value).some(holdsMask);
  return false;
}

function rowsOf(
  value: unknown,
  path: readonly ValueStep[],
  depth: number,
): readonly Row[] {
  const entries: [ValueStep, unknown][] = Array.isArray(value)
    ? value.map((item: unknown, index) => [index, item])
    : typeof value === "object" && value !== null
      ? Object.entries(value)
      : [];
  return entries.flatMap(([step, child]) => {
    const here = [...path, step];
    const label = typeof step === "number" ? `[${String(step)}]` : step;
    const nested = typeof child === "object" && child !== null;
    return [
      {
        path: here,
        parent: depth === 0 ? undefined : idOf(path),
        depth,
        label,
        text: nested ? undefined : textOf(child),
        masked: holdsMask(child),
      },
      ...(nested ? rowsOf(child, here, depth + 1) : []),
    ];
  });
}

const pathLabel = (path: readonly ValueStep[]): string =>
  path.reduce<string>(
    (text, step) =>
      typeof step === "number"
        ? `${text}[${String(step)}]`
        : text === ""
          ? step
          : `${text}.${step}`,
    "",
  );

/** The size a mask says, as a Secret's key says its own: `<16 bytes>` is `16 B`. */
function sizeOf(text: string): string | undefined {
  const bytes = /^<(\d+) bytes>$/.exec(text)?.[1];
  return bytes === undefined ? undefined : formatBytes(Number(bytes));
}

/**
 * A values document as rows of key paths in `ui`'s Tree, which the list
 * commands walk: each a Secret's data row, the key in content, a masked value's
 * size at the row's end and the ghost eye that reveals it, as a Secret's key
 * has them, a click or Enter on the row doing the same. A map or a list reveals
 * everything under it while something under it is masked. What a Reveal showed
 * stands in a muted block under its row, as a Secret's revealed value does.
 */
export function ValuesTree({
  document,
  defaults,
  shown,
  onGlyph,
}: {
  document: unknown;
  defaults: boolean;
  shown: ReadonlyMap<string, Shown>;
  onGlyph: (glyph: Glyph) => void;
}) {
  const register = useListRegistration();
  const rows = useMemo(() => rowsOf(document, [], 0), [document]);
  const glyphs = new Map<string, Glyph>();
  const revealedAt = new Set(
    [...shown.values()].flatMap(({ part }) =>
      part.kind === "values" ? [idOf(part.path)] : [],
    ),
  );
  const tree = rows.flatMap((row): TreeRow[] => {
    const part: HelmPart = { kind: "values", defaults, path: [...row.path] };
    const revealed = shown.has(partKey(part));
    const held = Array.from({ length: row.path.length + 1 }, (_, length) =>
      idOf(row.path.slice(0, length)),
    ).some((each) => revealedAt.has(each));
    const name = pathLabel(row.path);
    const id = idOf(row.path);
    const eye = revealed || row.masked;
    if (eye) {
      glyphs.set(id, {
        line: 0,
        to: 0,
        part,
        revealed,
        label: `${revealed ? "Hide" : "Reveal"} ${name}`,
      });
    }
    const size = row.text === undefined ? undefined : sizeOf(row.text);
    const main: TreeRow = {
      id,
      ...(row.parent !== undefined && { parent: row.parent }),
      depth: row.depth,
      label: (
        <span className="flex items-baseline gap-2">
          <span
            title={name}
            className="w-28 shrink-0 truncate font-mono text-xs"
          >
            {row.label}
          </span>
          {row.text !== undefined && !held && size === undefined && (
            <span className="min-w-0 truncate">{row.text}</span>
          )}
        </span>
      ),
      ...(eye && {
        trailing: (
          <span className="flex items-center gap-2">
            {size !== undefined && (
              <span className="text-xs text-support tabular-nums">{size}</span>
            )}
            <RevealButton
              label={name}
              showing={revealed}
              onClick={(event) => {
                event.stopPropagation();
                const glyph = glyphs.get(id);
                if (glyph) onGlyph(glyph);
              }}
            />
          </span>
        ),
      }),
    };
    return row.text !== undefined && held
      ? [
          main,
          {
            id: `${id}/revealed`,
            depth: row.depth,
            block: true,
            label: (
              <pre className="mb-1 max-h-80 overflow-auto rounded-lg bg-muted p-2 font-mono text-xs break-all whitespace-pre-wrap">
                {row.text}
              </pre>
            ),
          },
        ]
      : [main];
  });
  return (
    <Tree
      label="Values"
      rows={tree}
      tall
      onOpen={(id) => {
        const glyph = glyphs.get(id);
        if (glyph) onGlyph(glyph);
      }}
      onToggle={() => undefined}
      register={register}
    />
  );
}
