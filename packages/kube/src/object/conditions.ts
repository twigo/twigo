import type { Condition } from "@twigo/protocol";

export interface Said {
  readonly types: string[];
  readonly reason: string | null;
  readonly message: string | null;
}

/**
 * The wrong conditions that have something to say and that the Diagnostics
 * do not explain, those with the same reason and message sharing one line:
 * `Ready, ContainersReady` · `ContainersNotReady`.
 */
export function unexplained(conditions: readonly Condition[]): Said[] {
  const lines = new Map<string, Said>();
  for (const condition of conditions) {
    const { type, reason, message, explained } = condition;
    const wrong = condition.tone === "danger" || condition.tone === "warning";
    if (!wrong || explained || (message ?? reason) === null) continue;
    const key = JSON.stringify([reason, message]);
    const line = lines.get(key);
    if (line) line.types.push(type);
    else lines.set(key, { types: [type], reason, message });
  }
  return [...lines.values()];
}
