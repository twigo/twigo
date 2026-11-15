const FRESH_MS = 10 * 60 * 1000;

/**
 * The role of an age in text: one under ten minutes is worth reading now,
 * an older one only places the object.
 */
export function ageRole(ms: number): "text-content" | "text-support" {
  return ms < FRESH_MS ? "text-content" : "text-support";
}
