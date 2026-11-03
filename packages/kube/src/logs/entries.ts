import {
  CircleAlert,
  CircleCheck,
  Ellipsis,
  LogIn,
  LogOut,
} from "lucide-react";
import type {
  Gvr,
  LogEntry,
  LogMatches,
  LogPod,
  TextStyle,
} from "@twigo/protocol";
import type { LineItem, TextMark, TextRun } from "@twigo/ui";
import { humanDuration } from "@twigo/utils";

/** The resources whose logs a tab follows, and how its title names one (ARCHITECTURE 4.6). */
const TARGETS: Readonly<Record<string, string>> = {
  "/pods": "pod",
  "apps/deployments": "deployment",
  "apps/replicasets": "replicaset",
  "apps/statefulsets": "statefulset",
  "apps/daemonsets": "daemonset",
  "batch/jobs": "job",
  "batch/cronjobs": "cronjob",
};

/** The singular a tab's title gives the resource, undefined for one without logs. */
export function logsKind(gvr: Gvr): string | undefined {
  return TARGETS[`${gvr.group}/${gvr.resource}`];
}

/** The containers of a pod whose stream the source chose. */
export function followed(pod: LogPod) {
  return pod.containers.filter((container) => container.stream.state !== "off");
}

/** What a line shows of its pod: the part after its last dash, `h8lbx` of `auth-api-7f9c8d6b5-h8lbx`. */
export function podTag(pod: string): string {
  return pod.slice(pod.lastIndexOf("-") + 1);
}

/** `10:41:02.402` of a kubelet's stamp, in local time. */
export function clock(time: string): string {
  const at = new Date(time);
  if (Number.isNaN(at.getTime())) return time;
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
}

/**
 * The current match, `back` from the newest: its entry's index in the view,
 * its place counted from the entry's last mark, which the matches' cut at
 * 10,000 leaves whole, and its number among all the matches.
 */
export function currentMatch(
  matches: LogMatches | undefined,
  back: number,
): { index: number; fromEnd: number; number: number } | undefined {
  if (!matches) return undefined;
  const at = matches.entries.length - 1 - back;
  const index = matches.entries[at];
  if (index === undefined) return undefined;
  let fromEnd = 0;
  for (
    let after = at + 1;
    after < matches.entries.length && matches.entries[after] === index;
    after++
  )
    fromEnd++;
  return { index, fromEnd, number: matches.count - back };
}

/**
 * Where an anchored match is now, counted back from the newest: the entry
 * with its id at `index` in the view, and its mark `fromEnd`; undefined
 * when its entry is no longer in the matches.
 */
export function anchoredMatch(
  matches: LogMatches,
  index: number,
  fromEnd: number,
): number | undefined {
  let seen = 0;
  for (let at = matches.entries.length - 1; at >= 0; at--) {
    if (matches.entries[at] !== index) continue;
    if (seen === fromEnd) return matches.entries.length - 1 - at;
    seen++;
  }
  return undefined;
}

/**
 * A view's entry as the line list draws it: a line's level as its tone,
 * its ANSI runs and marks; a container's end, a pod that came or went,
 * or what the buffer dropped, as a marker.
 */
export function lineItem(
  entry: LogEntry,
  {
    tag,
    accent,
    current,
    now,
  }: {
    /** What the tag column shows of a pod's line. */
    tag: (pod: string, container: string) => string;
    accent: (pod: string) => boolean;
    /** The current match's place in this entry counted from its last mark, if it is in it. */
    current: number | undefined;
    now: number;
  },
): LineItem {
  const key = String(entry.id);
  switch (entry.type) {
    case "line":
      return {
        kind: "line",
        key,
        tag: tag(entry.pod, entry.container),
        tagAccent: accent(entry.pod),
        time: clock(entry.time),
        ...(entry.level === "warn" && { tone: "warn" as const }),
        ...(entry.level === "error" && { tone: "error" as const }),
        text: entry.text,
        runs: entry.styles.map(run),
        marks: entry.marks.map((mark, ordinal): TextMark => ({
          ...mark,
          current: entry.marks.length - 1 - ordinal === current,
        })),
      };
    case "ended": {
      const failed = entry.exitCode !== 0;
      // Once it has started again, the lines after the marker say so.
      const until =
        entry.restarting === null ? 0 : Date.parse(entry.restarting) - now;
      const restarting =
        until > 0 ? ` · restarting in ${humanDuration(until)}` : "";
      const code =
        entry.exitCode === null ? "" : ` with code ${String(entry.exitCode)}`;
      return {
        kind: "marker",
        key,
        icon: failed ? CircleAlert : CircleCheck,
        tone: failed ? "error" : "idle",
        tag: tag(entry.pod, entry.container),
        text: `Container ${entry.container} exited${code}${entry.reason && entry.reason !== "Completed" ? ` (${entry.reason})` : ""}${restarting}`,
      };
    }
    case "joined":
      return {
        kind: "marker",
        key,
        icon: LogIn,
        tag: podTag(entry.pod),
        text: `Pod ${entry.pod} joined${entry.owner ? ` from ${entry.owner.kind} ${entry.owner.name}` : ""}`,
      };
    case "left":
      return {
        kind: "marker",
        key,
        icon: LogOut,
        tag: podTag(entry.pod),
        text: `Pod ${entry.pod} left`,
      };
    case "dropped":
      return {
        kind: "marker",
        key,
        icon: Ellipsis,
        text: `${entry.count.toLocaleString("en")} older lines dropped · a tab keeps the last 50,000 lines or 32 MB`,
      };
  }
}

function run(style: TextStyle): TextRun {
  return {
    start: style.range.start,
    end: style.range.end,
    fg: style.fg,
    bg: style.bg,
    bold: style.bold,
    dim: style.dim,
    italic: style.italic,
    underline: style.underline,
  };
}
