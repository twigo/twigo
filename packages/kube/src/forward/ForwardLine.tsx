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
 * local port at the end. The state's words give way first: where the room
 * the row leaves is narrower than they are, they wrap onto a line it clips,
 * so they show whole or not at all; the target's name gives way next. The
 * port's name and the local port stay whole. A ready forward shows no words,
 * so its dot says the state to a screen reader, and the tooltip has what the
 * line leaves out. The row's ⋯ lies over the line's end, so the local port
 * goes, whole, while the ⋯ shows.
 */
export function ForwardLine({ forward }: { forward: Forward }) {
  const { label, tone, pulse, hollow, detail } = stateOf(forward);
  const ready = forward.state.state === "ready";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex w-full min-w-0 items-center">
          <StatusDot
            tone={tone}
            pulse={pulse}
            hollow={hollow}
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
            <span className="flex h-4 min-w-0 flex-1 flex-wrap overflow-hidden text-xs text-muted-foreground">
              <span className="h-4 w-1.5 shrink-0" />
              <span className="whitespace-nowrap">{label}</span>
            </span>
          )}
          <span className="ml-auto shrink-0 pl-1.5 group-hover/row:opacity-0 group-focus-within/row:opacity-0 group-has-[[data-state=open]]/row:opacity-0">
            {localWords(forward)}
          </span>
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
