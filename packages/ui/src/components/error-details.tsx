import { useEffect, useState } from "react";
import { cn } from "../lib/cn";

const SHOWN_MS = 1500;

type Result = "idle" | "copied" | "failed";

const LABEL = {
  idle: "Copy details",
  copied: "Copied",
  failed: "Could not copy",
} as const;

/**
 * What goes under an error's message: the name of its condition as a quiet
 * monospace line, and a button that copies the details a bug report needs.
 * Either can be left out; with neither it draws nothing.
 */
export function ErrorDetails({
  code,
  copy,
  notice = false,
  className,
}: {
  code?: string | undefined;
  /** What Copy details puts on the clipboard; without it there is no button. */
  copy?: string | undefined;
  /** Inside a notice, whose own buttons are brand text on a plate: so is Copy details. */
  notice?: boolean;
  className?: string;
}) {
  const [result, setResult] = useState<Result>("idle");
  useEffect(() => {
    if (result === "idle") return;
    const timer = setTimeout(() => {
      setResult("idle");
    }, SHOWN_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [result]);
  if (code === undefined && copy === undefined) return null;
  return (
    <span
      className={cn(
        "mt-1 flex flex-wrap items-center gap-x-3 text-left font-normal",
        className,
      )}
    >
      {code !== undefined && (
        <code className="font-mono text-2xs break-all text-quiet select-text">
          {code}
        </code>
      )}
      {copy !== undefined && (
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(copy).then(
              () => {
                setResult("copied");
              },
              () => {
                setResult("failed");
              },
            );
          }}
          className={cn(
            "rounded-sm outline-none focus-visible:shadow-[var(--focus-ring)]",
            notice
              ? "px-1.5 py-0.5 font-medium text-brand transition-colors hover:bg-brand/10"
              : "text-xs text-support underline-offset-2 hover:text-content hover:underline",
            result === "failed" && "text-error",
          )}
        >
          {LABEL[result]}
        </button>
      )}
    </span>
  );
}
