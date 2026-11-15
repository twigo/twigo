/**
 * The stage a row of actions should be at in `room` px, given what each
 * stage it has shown took (`needs`, undefined for a stage not shown yet):
 * one stage further when the current one does not fit, else the fullest that
 * is known to fit, since a stage's width is learnt only by showing it. Stage
 * 0 is the fullest and `last` the most compact, which stays when nothing fits.
 */
export function stageFor(
  needs: readonly (number | undefined)[],
  stage: number,
  room: number,
  last: number,
): number {
  if ((needs[stage] ?? 0) > room) return Math.min(stage + 1, last);
  let fullest = stage;
  while (fullest > 0 && (needs[fullest - 1] ?? Infinity) <= room) fullest--;
  return fullest;
}
