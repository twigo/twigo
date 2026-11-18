import {
  parseText,
  type Block,
  type Container,
  type Field,
  type Finding,
  type Overview,
  type Section,
  type TextFilter,
  type TreeNode,
  type Value,
} from "@twigo/protocol";

/** The title of the usage section, which the Overview draws apart from its document. */
export const USAGE_TITLE = "Usage";

/**
 * A filter as the list's text filter reads it (ARCHITECTURE 3.4): null while
 * the text keeps everything, and `invalid` while it is a closed regex that
 * does not parse, which keeps everything too.
 */
export function compile(text: string): {
  filter: TextFilter | null;
  invalid: boolean;
} {
  try {
    return { filter: parseText(text), invalid: false };
  } catch {
    return { filter: null, invalid: true };
  }
}

/** What names a tree's group in its section: the keys from the tree's top down to it. */
export const treeGroup = (path: readonly string[]) => `tree/${path.join("/")}`;

export const CONTAINER_GROUPS = {
  details: "Details",
  env: "Environment",
  mounts: "Mounts",
} as const;

/** What names a container's folded group in its section, and the remembered fold of it. */
export const containerGroup = (container: string, title: string) =>
  `containers/${container}/${title}`;

/** What an Overview draws of a section: its blocks as the filter and the defaults leave them. */
export interface SectionView {
  readonly blocks: readonly Block[];
  /**
   * The groups in it whose rows the filter narrowed, which draw open to show
   * what is left: those it kept rows of by their own texts, and under a
   * negation those it took rows from. Those it kept whole, by their title or
   * their own name, keep their fold.
   */
  readonly narrowed: ReadonlySet<string>;
  /** What the filter matched in it: its title, and each row that did; 0 without a filter. */
  readonly matches: number;
  /** The fields it holds that hold the cluster's default, hidden or not. */
  readonly defaults: number;
  /** The link at its end, which hides and shows its defaults, is offered. */
  readonly folds: boolean;
}

/**
 * A section as it is drawn. Without a filter its default fields go unless
 * `revealed`. With one, a section whose title matches stays whole, as it is
 * without a filter, and any other keeps the rows that match, the default
 * ones too, which then show: the filter finds what the link hides. A row's
 * texts include its section's title, so that a negation which the title
 * matches drops the whole section.
 */
export function viewOf(
  section: Section,
  filter: TextFilter | null,
  revealed: boolean,
): SectionView {
  const defaults = section.blocks.reduce(
    (count, block) =>
      count +
      (block.type === "fields"
        ? block.fields.filter((field) => field.default).length
        : 0),
    0,
  );
  const whole = {
    blocks:
      revealed || defaults === 0
        ? section.blocks
        : withoutDefaults(section.blocks),
    defaults,
    folds: defaults > 0,
  };
  if (filter === null) return { ...whole, narrowed: new Set(), matches: 0 };
  const titled = !filter.negated && filter.keeps([section.title]);
  const narrowed = new Set<string>();
  const rows = narrow(
    section.blocks,
    filter,
    titled ? [] : [section.title],
    narrowed,
  );
  if (titled)
    return { ...whole, narrowed: new Set(), matches: rows.matches + 1 };
  return {
    blocks: rows.blocks,
    narrowed,
    matches: rows.matches,
    defaults,
    folds: false,
  };
}

function withoutDefaults(blocks: readonly Block[]): Block[] {
  return blocks.flatMap((block): Block[] => {
    if (block.type !== "fields") return [block];
    const fields = block.fields.filter((field) => !field.default);
    return fields.length === 0 ? [] : [{ ...block, fields }];
  });
}

/** How many rows match in how many sections, with the usage section counted by its title only. */
export function matchesIn(
  overview: Overview,
  filter: TextFilter,
  usage: boolean,
): { matches: number; sections: number } {
  const counts = overview.sections.map(
    (section) => viewOf(section, filter, false).matches,
  );
  if (usage) counts.push(filter.keeps([USAGE_TITLE]) ? 1 : 0);
  return {
    matches: counts.reduce((sum, count) => sum + count, 0),
    sections: counts.filter((count) => count > 0).length,
  };
}

/** `3 matches in 2 sections`, or `3 in 2` where the room is short. */
export function describeMatches(
  matches: number,
  sections: number,
  short = false,
): string {
  if (matches === 0) return short ? "none" : "No matches";
  const count = matches.toLocaleString("en");
  const where = sections.toLocaleString("en");
  if (short) return `${count} in ${where}`;
  return `${count} ${matches === 1 ? "match" : "matches"} in ${where} ${sections === 1 ? "section" : "sections"}`;
}

/** `context` is what each row of the blocks sits in, whose texts the row's own come after. */
function narrow(
  blocks: readonly Block[],
  filter: TextFilter,
  context: readonly string[],
  narrowed: Set<string>,
): { blocks: Block[]; matches: number } {
  const kept: Block[] = [];
  let matches = 0;
  for (const block of blocks) {
    const found = narrowBlock(block, filter, context, narrowed);
    if (found === undefined) continue;
    kept.push(found.block);
    matches += found.matches;
  }
  return { blocks: kept, matches };
}

function rows<T>(
  items: readonly T[],
  texts: (item: T) => readonly string[],
  filter: TextFilter,
  context: readonly string[],
): T[] {
  return items.filter((item) => filter.keeps([...context, ...texts(item)]));
}

function narrowBlock(
  block: Block,
  filter: TextFilter,
  context: readonly string[],
  narrowed: Set<string>,
): { block: Block; matches: number } | undefined {
  switch (block.type) {
    case "fields": {
      const fields = rows(block.fields, fieldTexts, filter, context);
      return fields.length === 0
        ? undefined
        : { block: { ...block, fields }, matches: fields.length };
    }
    case "conditions": {
      const conditions = rows(
        block.conditions,
        (condition) => [
          condition.type,
          condition.status,
          condition.reason ?? "",
          condition.message ?? "",
        ],
        filter,
        context,
      );
      return conditions.length === 0
        ? undefined
        : { block: { ...block, conditions }, matches: conditions.length };
    }
    case "data": {
      const entries = rows(
        block.entries,
        (entry) => [entry.key],
        filter,
        context,
      );
      return entries.length === 0
        ? undefined
        : { block: { ...block, entries }, matches: entries.length };
    }
    case "tree": {
      const found = narrowNodes(block.nodes, filter, context, [], narrowed);
      return found.matches === 0
        ? undefined
        : { block: { ...block, nodes: found.nodes }, matches: found.matches };
    }
    case "events": {
      const events = rows(
        block.events,
        (event) => [
          event.type,
          event.reason,
          event.message,
          event.source,
          event.fieldPath ?? "",
        ],
        filter,
        context,
      );
      return events.length === 0
        ? undefined
        : { block: { ...block, events }, matches: events.length };
    }
    case "diagnostics": {
      const findings = rows(block.findings, findingTexts, filter, context);
      return findings.length === 0
        ? undefined
        : { block: { ...block, findings }, matches: findings.length };
    }
    case "containers": {
      const containers: Container[] = [];
      let matches = 0;
      for (const container of block.containers) {
        const found = narrowContainer(container, filter, context, narrowed);
        if (found === undefined) continue;
        containers.push(found.container);
        matches += found.matches;
      }
      return matches === 0
        ? undefined
        : { block: { ...block, containers }, matches };
    }
    case "table": {
      const kept = rows(
        block.rows,
        (row) => row.flatMap(valueTexts),
        filter,
        context,
      );
      return kept.length === 0
        ? undefined
        : { block: { ...block, rows: kept }, matches: kept.length };
    }
    case "list":
      return filter.keeps(context) ? { block, matches: 1 } : undefined;
  }
}

/**
 * A container whose name, image, state or ports match stays whole; else it
 * keeps the rows of its groups that do, a negation dropping the rows of a
 * container it matches.
 */
function narrowContainer(
  container: Container,
  filter: TextFilter,
  context: readonly string[],
  narrowed: Set<string>,
): { container: Container; matches: number } | undefined {
  const { name, role, image, state, ports } = container;
  const own = [
    name,
    role === "regular" ? "" : role,
    image,
    state?.text ?? "",
    ...ports,
  ];
  if (!filter.negated && filter.keeps(own)) return { container, matches: 1 };
  const within = [...context, ...own];
  const fields = rows(container.fields, fieldTexts, filter, within);
  const details = rows(container.details, fieldTexts, filter, within);
  const env = rows(container.env, fieldTexts, filter, within);
  const mounts = rows(container.mounts, fieldTexts, filter, within);
  const matches = fields.length + details.length + env.length + mounts.length;
  if (matches === 0) return undefined;
  for (const [title, all, kept] of [
    [CONTAINER_GROUPS.details, container.details, details],
    [CONTAINER_GROUPS.env, container.env, env],
    [CONTAINER_GROUPS.mounts, container.mounts, mounts],
  ] as const)
    if (opens(filter, all.length, kept.length))
      narrowed.add(containerGroup(name, title));
  return { container: { ...container, fields, details, env, mounts }, matches };
}

/** Whether a group that had `all` rows and kept `kept` of them is narrowed: it kept some by their own texts, and under a negation it also dropped some. */
function opens(filter: TextFilter, all: number, kept: number): boolean {
  return kept > 0 && (!filter.negated || kept < all);
}

function narrowNodes(
  nodes: readonly TreeNode[],
  filter: TextFilter,
  context: readonly string[],
  path: readonly string[],
  narrowed: Set<string>,
): { nodes: TreeNode[]; matches: number; dropped: boolean } {
  const kept: TreeNode[] = [];
  let matches = 0;
  let dropped = false;
  for (const node of nodes) {
    const { value } = node;
    const children =
      value.type === "map"
        ? value.entries
        : value.type === "list"
          ? value.items
          : [];
    if (value.type === "scalar") {
      if (filter.keeps([...context, node.label, node.key, value.text])) {
        kept.push(node);
        matches++;
      } else dropped = true;
    } else if (!filter.negated && filter.keeps([node.label, node.key])) {
      kept.push(node);
      matches++;
    } else if (children.length === 0) {
      if (filter.keeps([...context, node.label, node.key])) {
        kept.push(node);
        matches++;
      } else dropped = true;
    } else {
      const inner = narrowNodes(
        children,
        filter,
        [...context, node.label, node.key],
        [...path, node.key],
        narrowed,
      );
      if (inner.dropped) dropped = true;
      if (inner.matches === 0) {
        dropped = true;
        continue;
      }
      if (!filter.negated || inner.dropped)
        narrowed.add(treeGroup([...path, node.key]));
      kept.push({
        ...node,
        value:
          value.type === "map"
            ? { ...value, entries: inner.nodes }
            : { ...value, items: inner.nodes },
      });
      matches += inner.matches;
    }
  }
  return { nodes: kept, matches, dropped };
}

function fieldTexts(field: Field): string[] {
  return [field.label, ...valueTexts(field.value)];
}

function findingTexts(finding: Finding): string[] {
  return [
    finding.title,
    finding.message ?? "",
    ...finding.detail.flatMap((span) =>
      span.type === "text" ? [span.text] : [],
    ),
  ];
}

/** The text a value shows, a time as its date, a label as its key, its value and both. */
function valueTexts(value: Value): string[] {
  switch (value.type) {
    case "text":
    case "code":
    case "toned":
      return [value.text];
    case "time":
      return [new Date(value.at).toLocaleString()];
    case "link":
      return [value.text];
    case "labels":
      return value.labels.flatMap(({ key, value: text }) => [
        key,
        text,
        `${key}=${text}`,
      ]);
    case "list":
      return value.items.flatMap(valueTexts);
  }
}
