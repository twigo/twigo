import { cn } from "../lib/cn";
import { useCopy } from "../lib/useCopy";

const NAME = { copied: "Copied", failed: "Could not copy" } as const;

/**
 * A 12 px copy icon that puts `text` on the clipboard and says so for a
 * moment. It shows while the pointer is over the nearest ancestor that is a
 * `group/copy`, or the focus is within it, and is out of the tab order, so
 * that tabbing through a page's rows stops at what a row holds and not at its
 * copy icon. Its glyph is drawn by `.copy-glyph` in the stylesheet, so it is
 * one element.
 * By default it lies over the end of its nearest positioned ancestor, on the
 * editor's own fill, and takes no width of its own while hidden, which suits
 * a text that is cut, whose element has the whole text as its tooltip, since
 * the icon hides its end while it shows. A `floated` one comes first
 * in its text's block and floats at the end of the first line, a line tall: a
 * first line that reaches it wraps 16 px sooner, and nothing it lies beside is
 * covered, which suits a text that wraps.
 */
export function CopyButton({
  text,
  label,
  className,
  floated = false,
}: {
  text: string;
  /** What copying does, `Copy Image`: the button's name and its tooltip. */
  label: string;
  /** Where it lies in its ancestor, as `top-1`; it is at the end of it. */
  className?: string;
  floated?: boolean;
}) {
  const [result, copy] = useCopy(text);
  const name = result === "idle" ? label : NAME[result];
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={name}
      title={name}
      data-result={result}
      onClick={copy}
      className={cn(
        "copy-glyph inline-flex h-[18px] w-4 items-center justify-center rounded-sm text-support opacity-0 outline-none group-focus-within/copy:opacity-100 group-hover/copy:opacity-100 hover:text-content focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)]",
        floated ? "float-right" : "absolute top-0 right-0 bg-editor",
        result === "failed" && "text-error",
        className,
      )}
    />
  );
}
