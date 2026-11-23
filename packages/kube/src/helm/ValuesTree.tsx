import { useMemo } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { HelmPart, ValueStep } from "@twigo/protocol";
import { Tree, type TreeRow } from "@twigo/ui";
import { useListRegistration } from "@twigo/workbench";
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

/**
 * A values document as rows of key paths in `ui`'s Tree, which the list
 * commands walk: a 112 px label column and the value, a masked value showing
 * its size in the quiet role, and an eye that says Enter or a click on the
 * row reveals it, as a Secret's key does, or hides it once revealed. A map
 * or a list reveals everything under it while something under it is masked.
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
  const tree = rows.map((row): TreeRow => {
    const part: HelmPart = { kind: "values", defaults, path: [...row.path] };
    const revealed = shown.has(partKey(part));
    const name = pathLabel(row.path);
    const id = idOf(row.path);
    if (revealed || row.masked) {
      glyphs.set(id, {
        line: 0,
        to: 0,
        part,
        revealed,
        label: `${revealed ? "Hide" : "Reveal"} ${name}`,
      });
    }
    const Icon = revealed ? EyeOff : Eye;
    return {
      id,
      ...(row.parent !== undefined && { parent: row.parent }),
      depth: row.depth,
      label: (
        <span className="flex items-baseline gap-2">
          <span
            title={name}
            className="w-28 shrink-0 truncate font-mono text-xs text-support"
          >
            {row.label}
          </span>
          <span
            className={
              row.text !== undefined && MASK.test(row.text)
                ? "min-w-0 truncate text-quiet"
                : "min-w-0 truncate text-content"
            }
          >
            {row.text}
          </span>
        </span>
      ),
      ...((revealed || row.masked) && {
        trailing: (
          <Icon aria-hidden className="size-3.5 shrink-0 text-support" />
        ),
      }),
    };
  });
  return (
    <Tree
      label="Values"
      rows={tree}
      onOpen={(id) => {
        const glyph = glyphs.get(id);
        if (glyph) onGlyph(glyph);
      }}
      onToggle={() => undefined}
      register={register}
    />
  );
}
