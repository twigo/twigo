import { expect, test } from "vitest";
import type {
  ErrorKind,
  Level,
  LogMatches,
  LogView,
  LogWindow,
  ObjectRef,
  TextRange,
} from "../../generated";
import CASES from "../../log-cases.json";
import { LIMITS, LogBuffer, type Limits, type Timed } from "./buffer";
import { level } from "./level";
import { parse, time } from "./line";
import {
  BUCKETS,
  entries,
  histogram,
  judge,
  matches,
  rfc3339,
  spec,
  total,
} from "./view";

type CaseEntry =
  | {
      type: "line";
      pod: string;
      container: string;
      time: string;
      level: Level | null;
      text: string;
    }
  | {
      type: "ended";
      pod: string;
      container: string;
      time: string;
      exitCode: number | null;
      reason: string | null;
      restarting: string | null;
    }
  | { type: "joined"; pod: string; time: string; owner?: ObjectRef }
  | { type: "left"; pod: string; time: string };

interface ViewCase {
  name: string;
  limits?: Limits;
  entries: CaseEntry[];
  view: LogView;
  window: LogWindow;
  expect: {
    refused?: ErrorKind;
    total?: number;
    window?: { start: number; ids: number[] };
    marks?: Record<string, TextRange[]>;
    matches?: LogMatches;
    histogram?: {
      from: string;
      to: string;
      counts: Record<string, [number, number, number]>;
    };
    dropped?: { id: number; count: number };
  };
}

function timed(entry: CaseEntry): Timed {
  const at = time(entry.time);
  if (at === null) throw new Error(`${entry.time} is no time`);
  switch (entry.type) {
    case "line":
      return [at, { ...entry, styles: [] }];
    case "joined":
      return [at, { ...entry, owner: entry.owner ?? null }];
    case "ended":
    case "left":
      return [at, entry];
  }
}

for (const { name, raw, expect: wanted } of CASES.lines) {
  test(`a line: ${name}`, () => {
    const parsed = parse(raw);
    expect({
      time: parsed.at === null ? null : rfc3339(parsed.at),
      text: parsed.text,
      level: level(parsed.text),
      styles: parsed.styles,
    }).toEqual(wanted);
  });
}

for (const {
  name,
  limits,
  entries: given,
  view,
  window,
  expect: wanted,
} of CASES.views as ViewCase[]) {
  test(`a view: ${name}`, () => {
    if (wanted.refused !== undefined) {
      expect(() => spec(view)).toThrow(
        expect.objectContaining({ kind: wanted.refused }),
      );
      return;
    }
    const checked = spec(view);
    const buffer = new LogBuffer(limits ?? LIMITS);
    buffer.insert(given.map(timed), (kind) => judge(checked, kind));

    expect(total(buffer, checked)).toBe(wanted.total);
    const shown = entries(buffer, checked, window);
    expect({
      start: shown.start,
      ids: shown.entries.map((entry) => entry.id),
    }).toEqual(wanted.window);
    for (const entry of shown.entries) {
      if (entry.type !== "line") continue;
      expect(entry.marks, `the marks of ${String(entry.id)}`).toEqual(
        wanted.marks?.[String(entry.id)] ?? [],
      );
    }
    if (wanted.matches) {
      expect(matches(buffer, checked)).toEqual(wanted.matches);
    }
    if (wanted.histogram) {
      const { from, to, buckets } = histogram(buffer);
      expect(buckets).toHaveLength(wanted.histogram.from === "" ? 0 : BUCKETS);
      expect({
        from,
        to,
        counts: Object.fromEntries(
          buckets.flatMap((bucket, index) =>
            bucket.lines > 0
              ? [
                  [
                    String(index),
                    [bucket.lines, bucket.warnings, bucket.errors],
                  ],
                ]
              : [],
          ),
        ),
      }).toEqual(wanted.histogram);
    }
    expect(buffer.dropped).toEqual(wanted.dropped ?? null);
  });
}
