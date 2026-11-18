import type {
  Cell,
  Column,
  Condition,
  Container,
  Field,
  Finding,
  ObjectEvent,
  Overview,
  Printed,
  Section,
  Span,
  Value,
} from "../generated";

export const text = (value: string): Value => ({ type: "text", text: value });

export const toned = (value: string): Value => ({
  type: "toned",
  text: value,
  tone: "warning",
});

export const words = (value: string): Span[] => [{ type: "text", text: value }];

export const ago = (moment: number): Span => ({
  type: "ago",
  at: new Date(moment).toISOString(),
});

export function counted(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${String(count)} ${noun}s`;
}

/** `2 · 1 failing`: the cards of a pod's containers, as Rust's Containers section says them. */
export function containersSummary(containers: readonly Container[]): Span[] {
  const states = containers.flatMap(({ state }) => (state ? [state] : []));
  const failing = states.filter(({ tone }) => tone === "danger").length;
  const unready = states.filter(
    ({ tone, running, ready }) => tone === "warning" && running && !ready,
  ).length;
  return words(
    [
      String(containers.length),
      ...(failing > 0 ? [`${String(failing)} failing`] : []),
      ...(unready > 0 ? [`${String(unready)} not ready`] : []),
    ].join(" · "),
  );
}

/** An event of a controller, seen once at `moment`; a Normal one unless `more` says otherwise. */
export function event(
  source: string,
  reason: string,
  message: string,
  moment: number,
  more: Partial<Pick<ObjectEvent, "type" | "fieldPath">> = {},
): ObjectEvent {
  const at = new Date(moment).toISOString();
  return {
    type: "Normal",
    reason,
    message,
    source,
    count: 1,
    first: at,
    last: at,
    fieldPath: null,
    ...more,
  };
}

/**
 * The page's events as `events`, newest first, with the summary, tone and
 * fold Rust gives them: a warning is counted and its newest named, and
 * opens the section.
 */
export function withEvents(
  page: Overview,
  events: readonly ObjectEvent[],
): Overview {
  const newest = [...events].sort(
    (a, b) => Date.parse(b.last ?? "") - Date.parse(a.last ?? ""),
  );
  const warnings = newest.filter(({ type }) => type === "Warning");
  const [first] = newest;
  const [warned] = warnings;
  return amended(page, "core.events", (section) => ({
    ...section,
    summary: warned
      ? words(
          `${counted(warnings.length, "warning")} · ${warned.count > 1 ? `${warned.reason} ×${String(warned.count)}` : warned.reason}`,
        )
      : first
        ? [
            ...words(`${counted(newest.length, "event")} · `),
            ago(Date.parse(first.last ?? "")),
          ]
        : words("none"),
    tone: warned ? "warning" : null,
    fold: warned ? "open" : "folded",
    blocks: section.blocks.map((block) =>
      block.type === "events" ? { ...block, events: newest } : block,
    ),
  }));
}

export function amended(
  overview: Overview,
  id: string,
  change: (section: Section) => Section,
): Overview {
  return {
    ...overview,
    sections: overview.sections.map((section) =>
      section.id === id ? change(section) : section,
    ),
  };
}

export function withFields(
  section: Section,
  change: (fields: Field[]) => Field[],
): Section {
  return {
    ...section,
    blocks: section.blocks.map((block) =>
      block.type === "fields"
        ? { ...block, fields: change(block.fields) }
        : block,
    ),
  };
}

export function diagnosed(
  overview: Overview,
  findings: readonly Finding[],
): Overview {
  if (findings.length === 0) return overview;
  return {
    ...overview,
    sections: [
      {
        id: "core.diagnostics",
        title: "Diagnostics",
        summary: [],
        tone: findings.some(({ tone }) => tone === "danger")
          ? "danger"
          : "warning",
        fold: "open",
        blocks: [{ type: "diagnostics", findings: [...findings] }],
      },
      ...overview.sections,
    ],
  };
}

/**
 * A condition that a finding states: its status, the tone it gets there,
 * and `explained`, which the page shows as its chip alone.
 */
export function failing(
  condition: Condition,
  reason: string,
  message: string,
  since: number,
): Condition {
  return {
    ...condition,
    status: "False",
    tone: "warning",
    reason,
    message,
    lastTransition: new Date(since).toISOString(),
    explained: true,
  };
}

/** `3 of 5 ok`, over the conditions that are no state, as Rust counts them. */
export function conditionsSummary(conditions: readonly Condition[]): Span[] {
  const health = conditions.filter(({ tone }) => tone !== "neutral");
  const ok = health.filter(({ tone }) => tone === "success").length;
  return health.length === 0
    ? []
    : words(`${String(ok)} of ${String(health.length)} ok`);
}

/**
 * The document with the texts of `pairs` replaced wherever a string holds
 * them, in one pass so that a replacement is never read again, and the
 * strings of `whole` where they are a value alone.
 */
export function swapped(
  overview: Overview,
  pairs: ReadonlyMap<string, string>,
  whole: ReadonlyMap<string, string>,
): Overview {
  if (pairs.size === 0 && whole.size === 0) return overview;
  const pattern =
    pairs.size === 0
      ? null
      : new RegExp(
          [...pairs.keys()]
            .sort((a, b) => b.length - a.length)
            .map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("|"),
          "g",
        );
  const swap = (value: unknown): unknown => {
    if (typeof value === "string") {
      return (
        whole.get(value) ??
        (pattern === null
          ? value
          : value.replace(pattern, (found) => pairs.get(found) ?? found))
      );
    }
    if (Array.isArray(value)) return value.map(swap);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, swap(item)]),
      );
    }
    return value;
  };
  return swap(overview) as Overview;
}

/** The moment an object was made, in its header and in its Metadata. */
export function created(overview: Overview, moment: number): Overview {
  const at = new Date(moment).toISOString();
  const recorded = overview.header.created;
  return {
    ...amended(overview, "core.metadata", (section) => ({
      ...withFields(section, (fields) =>
        fields.map((field) =>
          field.label === "Created"
            ? { ...field, value: { type: "time", at } }
            : field,
        ),
      ),
      summary: section.summary.map((span) =>
        span.type === "ago" && span.at === recorded ? { ...span, at } : span,
      ),
    })),
    header: { ...overview.header, created: at },
  };
}

/** What a field of the document says, if it is text. */
export function fieldText(
  overview: Overview,
  label: string,
): string | undefined {
  const value = overview.sections
    .flatMap((section) => section.blocks)
    .flatMap((block) => (block.type === "fields" ? block.fields : []))
    .find((field) => field.label === label)?.value;
  return value?.type === "text" || value?.type === "code"
    ? value.text
    : undefined;
}

/**
 * The cells a list's row printed for an object, as Rust keeps them: not its
 * name, age, empty cells or the printers' `<none>`.
 */
export function printed(
  columns: readonly Column[],
  cells: readonly Cell[],
): Printed[] {
  return columns.flatMap((column, index) => {
    const cell = cells[index];
    return index === 0 ||
      column.kind === "age" ||
      cell === null ||
      cell === undefined ||
      cell === "" ||
      cell === "<none>"
      ? []
      : [{ column: column.name, value: String(cell) }];
  });
}
