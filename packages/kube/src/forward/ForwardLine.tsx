import { useState } from "react";
import type { Forward } from "@twigo/protocol";
import {
  cn,
  StatusDot,
  TonedText,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@twigo/ui";
import { KindIcon } from "../KindIcon";
import { useWidth } from "../useWidth";
import { addressOf, localWords, portLabel, portWords, stateOf } from "./words";

/**
 * A forward as one line that fits a side bar: its state's dot, its kind's
 * icon, the target and port, the state's words when it is not ready, and the
 * local port at the end. The state's words give way first, and show only
 * where the room the row leaves is as wide as they are; the target's name
 * gives way next. The port's name and the local port stay whole. Where the
 * words are not shown, the dot says the state to a screen reader, and the
 * tooltip has what the line leaves out. The row's ⋯ lies over the line's end,
 * so the local port goes, whole, while the ⋯ shows.
 */
export function ForwardLine({ forward }: { forward: Forward }) {
  const { label, tone, pulse, hollow, detail } = stateOf(forward);
  const ready = forward.state.state === "ready";
  const [room, setRoom] = useState<HTMLElement | null>(null);
  const [words, setWords] = useState<HTMLElement | null>(null);
  const available = useWidth(room);
  const needed = useWidth(words);
  const spoken = !ready && needed > 0 && available >= needed;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex w-full min-w-0 items-center">
          <StatusDot
            tone={tone}
            pulse={pulse === true}
            hollow={hollow === true}
            className="mr-1.5"
            {...(!spoken && { label })}
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
            <span ref={setRoom} className="min-w-0 flex-1 overflow-hidden">
              <span
                ref={setWords}
                aria-hidden={!spoken || undefined}
                className={cn(
                  "block w-max text-xs text-muted-foreground",
                  !spoken && "invisible",
                )}
              >
                <span className="inline-block w-1.5" />
                {label}
              </span>
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
