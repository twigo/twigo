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

/** Cells that carry a status, by `group/resource/column`. */
const TONES: Readonly<Record<string, (text: string) => Tone | undefined>> = {
  "/pods/Status": podStatus,
};

/** The column that carries a resource's status, which the status bar counts by. */
export function statusColumn(gvr: Gvr): string | undefined {
  const prefix = `${gvr.group}/${gvr.resource}/`;
  const key = Object.keys(TONES).find((candidate) =>
    candidate.startsWith(prefix),
  );
  return key?.slice(prefix.length);
}

export function cellTone(
  gvr: Gvr,
  column: string,
  text: string,
): Tone | undefined {
  return TONES[`${gvr.group}/${gvr.resource}/${column}`]?.(text);
}
