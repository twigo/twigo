export interface SubjectStat {
  subject: string;
  count: number;
  rate: number;
}

export interface SubjectNode {
  token: string;
  path: string;
  count: number;
  rate: number;
  children: SubjectNode[];
}

// Build-time node: children keyed by token for O(1) lookup (vs a linear scan per
// token per stat, which is quadratic on wide trees rebuilt every snapshot).
interface BuildNode {
  token: string;
  path: string;
  count: number;
  rate: number;
  children: Map<string, BuildNode>;
}

function toSorted(level: Map<string, BuildNode>): SubjectNode[] {
  return [...level.values()]
    .map((b) => ({
      token: b.token,
      path: b.path,
      count: b.count,
      rate: b.rate,
      children: toSorted(b.children),
    }))
    .sort((a, b) => a.token.localeCompare(b.token));
}

/** Aggregate flat subject stats into a token tree; each node sums its descendants. */
export function buildSubjectTree(stats: SubjectStat[]): SubjectNode[] {
  const roots = new Map<string, BuildNode>();
  for (const stat of stats) {
    const tokens = stat.subject.split(".");
    let level = roots;
    let path = "";
    for (const token of tokens) {
      path = path ? `${path}.${token}` : token;
      let node = level.get(token);
      if (!node) {
        node = { token, path, count: 0, rate: 0, children: new Map() };
        level.set(token, node);
      }
      node.count += stat.count;
      node.rate += stat.rate;
      level = node.children;
    }
  }
  return toSorted(roots);
}
