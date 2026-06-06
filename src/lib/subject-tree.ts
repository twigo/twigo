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

function sortNodes(nodes: SubjectNode[]) {
  nodes.sort((a, b) => a.token.localeCompare(b.token));
  for (const node of nodes) sortNodes(node.children);
}

/** Aggregate flat subject stats into a token tree; each node sums its descendants. */
export function buildSubjectTree(stats: SubjectStat[]): SubjectNode[] {
  const roots: SubjectNode[] = [];
  for (const stat of stats) {
    const tokens = stat.subject.split(".");
    let siblings = roots;
    let path = "";
    for (const token of tokens) {
      path = path ? `${path}.${token}` : token;
      let node = siblings.find((n) => n.token === token);
      if (!node) {
        node = { token, path, count: 0, rate: 0, children: [] };
        siblings.push(node);
      }
      node.count += stat.count;
      node.rate += stat.rate;
      siblings = node.children;
    }
  }
  sortNodes(roots);
  return roots;
}
