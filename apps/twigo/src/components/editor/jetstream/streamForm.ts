export interface StreamFormInitial {
  name: string;
  subjects: string;
  storage: string;
  retention: string;
  discard: string;
  maxMsgs: string;
  maxBytes: string;
  maxAgeSec: string;
  replicas: string;
}

export interface StreamChange {
  key: string;
  from: string;
  to: string;
}

export function buildStreamPatch(
  f: StreamFormInitial,
): Record<string, unknown> {
  const subjects = f.subjects
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    name: f.name.trim(),
    subjects,
    storage: f.storage,
    retention: f.retention,
    discard: f.discard,
    max_msgs: Number(f.maxMsgs) || -1,
    max_bytes: Number(f.maxBytes) || -1,
    max_age: (Number(f.maxAgeSec) || 0) * 1_000_000_000,
    num_replicas: Number(f.replicas) || 1,
  };
}

function display(key: string, value: unknown): string {
  if (key === "max_age") {
    const sec = Number(value) / 1e9;
    return sec <= 0 ? "unlimited" : `${String(sec)}s`;
  }
  if ((key === "max_msgs" || key === "max_bytes") && Number(value) === -1) {
    return "unlimited";
  }
  if (Array.isArray(value)) return value.join(", ");
  return typeof value === "string" ? value : JSON.stringify(value);
}

// Both sides normalize through buildStreamPatch, so only real edits surface.
export function diffStreamPatch(
  initial: StreamFormInitial,
  edited: StreamFormInitial,
): StreamChange[] {
  const before = buildStreamPatch(initial);
  const after = buildStreamPatch(edited);
  return Object.keys(after)
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => ({
      key,
      from: display(key, before[key]),
      to: display(key, after[key]),
    }));
}
