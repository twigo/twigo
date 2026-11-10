import type { CSSProperties } from "react";
import { Lock, ShieldAlert } from "lucide-react";
import type { Environment, Mode } from "@twigo/protocol";
import { useChanges, useWorkbench } from "../react";
import { contextAccent } from "../spaces/colors";
import { environmentLabel, modeLabel } from "../spaces/modes";

export function ContextBadge({
  context,
  environment,
  mode,
}: {
  context: string;
  environment: Environment | null;
  mode: Mode;
}) {
  const { colors } = useWorkbench();
  useChanges(colors.changes);
  const color = colors.of(context);
  const type = environment === null ? undefined : environmentLabel(environment);
  const label = type ?? (mode === "read-write" ? undefined : modeLabel(mode));
  const Icon = mode === "guarded" ? ShieldAlert : Lock;
  return (
    <>
      {label && (
        <span
          className="twigo-mode-chip flex h-5 items-center gap-1 rounded px-[7px] text-[11px] font-semibold"
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
      <span className="text-muted-foreground">{context}</span>
    </>
  );
}
