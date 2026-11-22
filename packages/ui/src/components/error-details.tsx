import { cn } from "../lib/cn";
import { useCopy } from "../lib/useCopy";

const LABEL = {
  idle: "Copy details",
  copied: "Copied",
  failed: "Could not copy",
} as const;

/**
 * What goes under an error's message: the name of its condition as a quiet
 * monospace line, and a button that copies the details a bug report needs.
 */
export function ErrorDetails({
  code,
  copy,
  notice = false,
  onReport,
  className,
}: {
  code: string;
  /** What Copy details puts on the clipboard. */
  copy: string;
  /** Inside a notice, whose own buttons are brand text on a plate: so are the buttons here. */
  notice?: boolean;
  /** Where the error is Twigo's own, a button after Copy details that reports it. */
  onReport?: () => void;
  className?: string;
}) {
  const [result, onCopy] = useCopy(copy);
  const button = cn(
    "rounded-sm outline-none focus-visible:shadow-[var(--focus-ring)]",
    notice
      ? "px-1.5 py-0.5 font-medium text-brand transition-colors hover:bg-brand/10"
      : "text-xs text-support underline-offset-2 hover:text-content hover:underline",
  );
  return (
    <span
      className={cn(
        "mt-1 flex flex-wrap items-center gap-x-3 text-left font-normal",
        className,
      )}
    >
      <code className="font-mono text-2xs break-all text-quiet select-text">
        {code}
      </code>
      <button
        type="button"
        onClick={onCopy}
        className={cn(button, result === "failed" && "text-error")}
      >
        {LABEL[result]}
      </button>
      {onReport && (
        <button type="button" onClick={onReport} className={button}>
          Report…
        </button>
      )}
    </span>
  );
}
