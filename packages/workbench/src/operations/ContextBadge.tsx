import type { CSSProperties } from "react";
import { Lock, ShieldAlert } from "lucide-react";
import type { Environment, Mode } from "@twigo/protocol";
import { useChanges, useWorkbench } from "../react";
import { contextAccent } from "../spaces/colors";
import { environmentLabel, modeLabel } from "../spaces/modes";
import { spaceMark } from "../parts/spaceMark";

/**
 * Where a dialog acts: the tile of the context's space, which stays on the
 * dialog whichever space is shown, then the context's type or mode and its name.
 */
export function ContextBadge({
  context,
  environment,
  mode,
}: {
  context: string;
  environment: Environment | null;
  mode: Mode;
}) {
  const { colors, spaces } = useWorkbench();
  useChanges(colors.changes);
  useChanges(spaces.changes);
  const color = colors.of(context);
  const space = spaces.ofContext(context);
  const type = environment === null ? undefined : environmentLabel(environment);
  const label = type ?? (mode === "read-write" ? undefined : modeLabel(mode));
  const Icon = mode === "guarded" ? ShieldAlert : Lock;
  return (
    <>
      {spaceMark(space)}
      {label && (
        <span
          className="twigo-mode-chip flex h-5 items-center gap-1 rounded-sm px-[7px] text-2xs font-semibold"
          style={
            {
              "--twigo-context": contextAccent(color),
              "--twigo-context-ink": `var(--context-${color}-ink)`,
            } as CSSProperties
          }
        >
          {mode !== "read-write" && <Icon aria-hidden className="size-3" />}
          {label}
        </span>
      )}
      <span className="text-support">{context}</span>
    </>
  );
}
