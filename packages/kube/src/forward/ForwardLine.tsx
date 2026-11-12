import type { Forward } from "@twigo/protocol";
import {
  StatusDot,
  TonedText,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@twigo/ui";
import { KindIcon } from "../KindIcon";
import { addressOf, localWords, portLabel, portWords, stateOf } from "./words";

/**
 * A forward as one line that fits a side bar: its state's dot, its kind's
 * icon, the target and port, the state's words when it is not ready, and the
 * local port at the end. The state's words give way first, and go whole
 * under 2.5rem rather than leave a letter; the target's name gives way next.
 * The port's name and the local port stay whole. The tooltip has what the
 * line leaves out.
 */
export function ForwardLine({ forward }: { forward: Forward }) {
  const { label, tone, pulse, detail } = stateOf(forward);
  const ready = forward.state.state === "ready";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex w-full min-w-0 items-center">
          <StatusDot
            tone={tone}
            pulse={pulse === true}
            className="mr-1.5"
            {...(ready && { label })}
          />
          <KindIcon
            gvr={forward.target.gvr}
            className="mr-1.5 size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="flex min-w-0">
            <span className="truncate">{forward.target.name}</span>
            <span className="shrink-0">:{portLabel(forward)}</span>
          </span>
          {!ready && (
            <span className="@container min-w-0 flex-1">
              <span className="ml-1.5 block truncate text-xs text-muted-foreground @max-[2.5rem]:hidden">
                {label}
              </span>
            </span>
          )}
          <span className="ml-auto shrink-0 pl-1.5">{localWords(forward)}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="grid gap-0.5 break-words">
        <span>
          {forward.kind} {forward.target.name}
        </span>
        <span className="text-muted-foreground">
          {portWords(forward)} → {addressOf(forward)}
        </span>
        <span>
          <TonedText tone={tone}>{label}</TonedText>
          {detail !== undefined && (
            <span className="text-muted-foreground"> · {detail}</span>
          )}
        </span>
        {forward.pod !== null && (
          <span className="text-muted-foreground">Pod {forward.pod}</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
