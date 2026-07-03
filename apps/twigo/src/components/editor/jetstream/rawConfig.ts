export type ParsedRawConfig =
  { ok: true; config: Record<string, unknown> } | { ok: false; error: string };

export function parseRawConfig(text: string, stream: string): ParsedRawConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${String(e)}` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "Config must be a JSON object." };
  }
  const config = value as Record<string, unknown>;
  if (config.name !== stream) {
    return { ok: false, error: `"name" must stay "${stream}".` };
  }
  return { ok: true, config };
}

export interface RawChange {
  key: string;
  kind: "added" | "removed" | "changed";
  from?: string;
  to?: string;
}

function show(v: unknown): string {
  const s = JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

export function diffRawConfig(
  current: Record<string, unknown>,
  edited: Record<string, unknown>,
): RawChange[] {
  const keys = [...new Set([...Object.keys(current), ...Object.keys(edited)])];
  const out: RawChange[] = [];
  for (const key of keys) {
    const inCur = key in current;
    const inNew = key in edited;
    if (inCur && !inNew) {
      out.push({ key, kind: "removed", from: show(current[key]) });
    } else if (!inCur && inNew) {
      out.push({ key, kind: "added", to: show(edited[key]) });
    } else if (JSON.stringify(current[key]) !== JSON.stringify(edited[key])) {
      out.push({
        key,
        kind: "changed",
        from: show(current[key]),
        to: show(edited[key]),
      });
    }
  }
  return out;
}
