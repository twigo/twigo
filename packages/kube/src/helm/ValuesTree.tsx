import { Eye, EyeOff } from "lucide-react";
import type { HelmPart, ValueStep } from "@twigo/protocol";
import { MASK, partKey, type Glyph, type Shown } from "./reveals";

interface Row {
  readonly path: readonly ValueStep[];
  readonly depth: number;
  readonly label: string;
  /** A leaf's text; none for a map or a list. */
  readonly text: string | undefined;
  /** Whether a masked value stands in this row or under it. */
  readonly masked: boolean;
}

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
        depth,
        label,
        text: nested ? undefined : textOf(child),
        masked: holdsMask(child),
      },
      ...(nested ? rowsOf(child, here, depth + 1) : []),
    ];
  });
}

/**
 * A values document as rows of key paths: a 112 px label column and the value,
 * a masked value showing its size in the quiet role with an eye that reveals
 * it, as a Secret's key does, and a revealed subtree with an eye that hides it.
 * A map or a list has an eye of its own while something under it is masked,
 * which reveals everything under it.
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
  const rows = rowsOf(document, [], 0);
  const label = (path: readonly ValueStep[]) =>
    path.reduce<string>(
      (text, step) =>
        typeof step === "number"
          ? `${text}[${String(step)}]`
          : text === ""
            ? step
            : `${text}.${step}`,
      "",
    );
  return (
    <ul
      role="tree"
      aria-label="Values"
      className="flex flex-col py-2 text-body"
    >
      {rows.map((row) => {
        const part: HelmPart = {
          kind: "values",
          defaults,
          path: [...row.path],
        };
        const revealed = shown.has(partKey(part));
        const eye = revealed || row.masked;
        const name = label(row.path);
        return (
          <li
            key={name}
            role="treeitem"
            aria-level={row.depth + 1}
            style={{ paddingLeft: 14 + row.depth * 16 }}
            className="flex min-h-6 items-baseline gap-2 pr-3.5"
          >
            <span
              title={name}
              className="w-28 shrink-0 truncate font-mono text-xs text-support"
            >
              {row.label}
            </span>
            <span
              className={
                row.text !== undefined && MASK.test(row.text)
                  ? "min-w-0 flex-1 truncate text-quiet"
                  : "min-w-0 flex-1 truncate text-content"
              }
            >
              {row.text}
            </span>
            {eye && (
              <button
                type="button"
                aria-label={`${revealed ? "Hide" : "Reveal"} ${name}`}
                title={`${revealed ? "Hide" : "Reveal"} ${name}`}
                onClick={() => {
                  onGlyph({
                    line: 0,
                    part,
                    revealed,
                    label: `${revealed ? "Hide" : "Reveal"} ${name}`,
                  });
                }}
                className="flex size-5 shrink-0 items-center justify-center rounded-sm text-support outline-none hover:text-strong focus-visible:shadow-[var(--focus-ring)]"
              >
                {revealed ? (
                  <EyeOff aria-hidden className="size-3.5" />
                ) : (
                  <Eye aria-hidden className="size-3.5" />
                )}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
