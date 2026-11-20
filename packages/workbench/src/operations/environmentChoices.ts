import type { Environment } from "@twigo/protocol";
import type { ConfirmChoice } from "@twigo/ui";
import {
  ENVIRONMENTS,
  environmentHelp,
  environmentLabel,
} from "../spaces/modes";

/** One button for each type a context nobody marked can be. */
export function environmentChoices(
  onSelect: (environment: Environment) => void,
): ConfirmChoice[] {
  return ENVIRONMENTS.map((environment) => ({
    label: environmentLabel(environment),
    onSelect: () => {
      onSelect(environment);
    },
  }));
}

/** What each type gives, a line each, for the person who is asked which it is. */
export function environmentLines(): string[] {
  return ENVIRONMENTS.map(
    (environment) =>
      `${environmentLabel(environment)}: ${environmentHelp(environment)}`,
  );
}
