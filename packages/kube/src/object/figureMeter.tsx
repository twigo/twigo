import type { ReactNode } from "react";
import { Meter } from "@twigo/ui";
import { spoken, type Figure } from "./figures";

export function meterOf(
  label: string,
  shown: Figure,
  className?: string,
): ReactNode {
  return shown.bar ? (
    <Meter
      label={label}
      valueText={spoken(shown)}
      {...shown.bar}
      {...(shown.tone && { tone: shown.tone })}
      {...(className !== undefined && { className })}
    />
  ) : null;
}
