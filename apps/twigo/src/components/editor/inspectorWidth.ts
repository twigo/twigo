export const MIN_MAIN = 320;
export const MIN_INSPECTOR = 260;
export const KEY_STEP = 24;

export function clampInspectorWidth(next: number, container: number): number {
  const atLeastMin = Math.max(next, MIN_INSPECTOR);
  // A hidden dockview tab measures zero; clamping against that would snap the
  // width to the minimum behind the user's back.
  if (container <= 0) return Math.round(atLeastMin);
  return Math.round(
    Math.min(atLeastMin, Math.max(MIN_INSPECTOR, container - MIN_MAIN)),
  );
}
