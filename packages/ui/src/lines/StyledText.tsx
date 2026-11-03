import { cn } from "../lib/cn";

/** A terminal's sixteen colours, which the theme maps to tokens. */
export type AnsiColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

/** Indexes text in UTF-16 units; `end` is exclusive. */
export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

/** A run of text an ANSI escape styled. */
export interface TextRun extends TextSpan {
  readonly fg: AnsiColor | null;
  readonly bg: AnsiColor | null;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
}

/** A search match; the current one is filled. */
export interface TextMark extends TextSpan {
  readonly current: boolean;
}

const FG: Readonly<Record<AnsiColor, string>> = {
  black: "text-ansi-black",
  red: "text-ansi-red",
  green: "text-ansi-green",
  yellow: "text-ansi-yellow",
  blue: "text-ansi-blue",
  magenta: "text-ansi-magenta",
  cyan: "text-ansi-cyan",
  white: "text-ansi-white",
  brightBlack: "text-ansi-bright-black",
  brightRed: "text-ansi-bright-red",
  brightGreen: "text-ansi-bright-green",
  brightYellow: "text-ansi-bright-yellow",
  brightBlue: "text-ansi-bright-blue",
  brightMagenta: "text-ansi-bright-magenta",
  brightCyan: "text-ansi-bright-cyan",
  brightWhite: "text-ansi-bright-white",
};

const BG: Readonly<Record<AnsiColor, string>> = {
  black: "bg-ansi-black/25",
  red: "bg-ansi-red/25",
  green: "bg-ansi-green/25",
  yellow: "bg-ansi-yellow/25",
  blue: "bg-ansi-blue/25",
  magenta: "bg-ansi-magenta/25",
  cyan: "bg-ansi-cyan/25",
  white: "bg-ansi-white/25",
  brightBlack: "bg-ansi-bright-black/25",
  brightRed: "bg-ansi-bright-red/25",
  brightGreen: "bg-ansi-bright-green/25",
  brightYellow: "bg-ansi-bright-yellow/25",
  brightBlue: "bg-ansi-bright-blue/25",
  brightMagenta: "bg-ansi-bright-magenta/25",
  brightCyan: "bg-ansi-bright-cyan/25",
  brightWhite: "bg-ansi-bright-white/25",
};

/**
 * Text as a terminal styled it, its search matches marked: rendered as
 * text, never as markup, so a log line cannot inject any.
 */
export function StyledText({
  text,
  runs,
  marks,
}: {
  text: string;
  runs: readonly TextRun[];
  marks: readonly TextMark[];
}) {
  if (runs.length === 0 && marks.length === 0) return <>{text}</>;
  const cuts = new Set([0, text.length]);
  for (const span of [...runs, ...marks]) {
    cuts.add(Math.max(0, Math.min(text.length, span.start)));
    cuts.add(Math.max(0, Math.min(text.length, span.end)));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const parts = [];
  for (let index = 0; index + 1 < points.length; index++) {
    const start = points[index] ?? 0;
    const end = points[index + 1] ?? start;
    if (end <= start) continue;
    const run = runs.find((each) => each.start <= start && end <= each.end);
    const mark = marks.find((each) => each.start <= start && end <= each.end);
    const piece = text.slice(start, end);
    if (!run && !mark) {
      parts.push(piece);
      continue;
    }
    parts.push(
      <span
        key={start}
        className={cn(
          run?.fg && FG[run.fg],
          run?.bg && BG[run.bg],
          run?.bold && "font-semibold",
          run?.dim && "opacity-70",
          run?.italic && "italic",
          run?.underline && "underline",
          mark &&
            (mark.current
              ? "rounded-xs bg-mark-current text-mark-current-foreground"
              : "rounded-xs bg-mark text-foreground"),
        )}
      >
        {piece}
      </span>,
    );
  }
  return <>{parts}</>;
}
