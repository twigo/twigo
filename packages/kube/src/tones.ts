import type { Gvr } from "@twigo/protocol";

/** Colour belongs to abnormal states only (ARCHITECTURE 4.9). */
export type Tone = "warn" | "error";

const POD_ERROR =
  /Err|BackOff|OOMKilled|Evicted|Unknown|NodeLost|InvalidImageName/;
const POD_WARN =
  /^(Pending|ContainerCreating|PodInitializing|Terminating|Init:)/;

function podStatus(text: string): Tone | undefined {
  if (POD_ERROR.test(text)) return "error";
  if (POD_WARN.test(text)) return "warn";
  return undefined;
}

/** A ratio such as Ready's `1/2` is pending until both sides match. */
function ratio(text: string): Tone | undefined {
  const [ready, total] = text.split("/");
  return ready !== undefined && total !== undefined && ready !== total
    ? "warn"
    : undefined;
}

/** Cells that carry a tone, by `group/resource/column`. */
const TONES: Readonly<Record<string, (text: string) => Tone | undefined>> = {
  "/pods/Status": podStatus,
  "/pods/Ready": ratio,
};

/** The column that carries a resource's status, by `group/resource`. */
const STATUS_COLUMNS: Readonly<Record<string, string>> = {
  "/pods": "Status",
};

/** The column that carries a resource's status, which the status bar and the health chips count by. */
export function statusColumn(gvr: Gvr): string | undefined {
  return STATUS_COLUMNS[`${gvr.group}/${gvr.resource}`];
}

export function cellTone(
  gvr: Gvr,
  column: string,
  text: string,
): Tone | undefined {
  return TONES[`${gvr.group}/${gvr.resource}/${column}`]?.(text);
}
