import { useState } from "react";
import { fitStage } from "./headerStage";
import { useChildWidths, useClientWidth } from "./pageStage";

/**
 * The stage a header's line is drawn at: the fullest of `stages` whose width
 * fits `room`, by `copies`, the hidden box that holds each stage drawn at its
 * narrowest, one child each. Neither the room nor a copy is changed by the
 * stage. The margin before a fuller stage holds a change of room and a copy
 * that came out another width, as an age does that crosses into another range;
 * it holds nothing for another `object`, whose copies are not measured until
 * drawn, nor for a copy whose cut waits for its font: the line takes the
 * fullest stage that fits. `settled` says that every copy is measured.
 */
export function useLineStage<S>(
  stages: readonly [S, ...S[]],
  room: HTMLElement | null,
  copies: HTMLElement | null,
  object: string,
): { at: number; stage: S; settled: boolean } {
  const width = useClientWidth(room);
  const needs = useChildWidths(copies, object);
  const [decided, setDecided] = useState({ needs, at: 0 });
  const held =
    decided.needs.length === needs.length &&
    decided.needs.every((need) => need > 0);
  const at = fitStage(needs, width, decided.at, held);
  if (at !== decided.at || needs !== decided.needs) setDecided({ needs, at });
  return {
    at,
    stage: stages[at] ?? stages[0],
    settled: needs.length > 0 && needs.every((need) => need > 0),
  };
}
