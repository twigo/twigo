import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import type { Tone } from "../lib/tone";
import { Skeleton } from "./skeleton";

/** A share of a tile's total, drawn in its tone on the tile's bar. */
export interface StatSegment {
  readonly tone: Tone;
  readonly value: number;
}

const SEGMENT: Readonly<Record<Tone, string>> = {
  error: "bg-error",
  warn: "bg-warn",
  ok: "bg-ok",
  idle: "bg-muted-foreground-2",
};

/**
 * A number that sums something up, its label above and a line of detail
 * below, as the cluster's home counts its nodes and pods. A value it could
 * not take shows "–", never 0, and the detail says why. With segments, a bar
 * shows their shares of the value; with `onOpen`, the tile opens what it
 * counts.
 */
export function StatTile({
  label,
  value,
  loading = false,
  segments,
  onOpen,
  className,
  children,
}: {
  label: string;
  /** Undefined when it could not be counted. */
  value: number | undefined;
  loading?: boolean;
  segments?: readonly StatSegment[];
  onOpen?: () => void;
  className?: string;
  children?: ReactNode;
}) {
  const body = (
    <>
      <span className="text-xs text-muted-foreground">{label}</span>
      {loading ? (
        <>
          <Skeleton className="my-1 h-5 w-16" />
          <Skeleton className="my-0.5 h-3 w-24" />
        </>
      ) : (
        <>
          <span className="text-[22px] leading-7 font-semibold tracking-[-0.01em] tabular-nums">
            {value === undefined ? "–" : value.toLocaleString("en")}
          </span>
          <span className="min-w-0 text-xs">{children}</span>
        </>
      )}
      {segments && value !== undefined && value > 0 && (
        <span
          aria-hidden
          className="mt-1.5 flex h-1 overflow-hidden rounded-sm bg-[color-mix(in_oklab,var(--foreground)_12%,transparent)]"
        >
          {segments.map((segment) => (
            <span
              key={segment.tone}
              className={SEGMENT[segment.tone]}
              style={{ width: `${(segment.value / value) * 100}%` }}
            />
          ))}
        </span>
      )}
    </>
  );
  const frame = cn(
    "grid min-w-0 content-start gap-1 rounded-lg bg-editor px-3.5 py-3 text-left shadow-[inset_0_0_0_1px_var(--border)]",
    className,
  );
  if (!onOpen) return <div className={frame}>{body}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        frame,
        "outline-none hover:bg-row-hover focus-visible:shadow-[var(--focus-ring)]",
      )}
    >
      {body}
    </button>
  );
}
