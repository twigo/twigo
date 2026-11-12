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
 * gives way next. The port's name and the local port stay whole. The tooltip
 * has what the line leaves out.
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
          {!ready && <Words>{label}</Words>}
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

/** The state's words, whole or not at all: no part of a word is left where the row has no room for it. */
function Words({ children }: { children: string }) {
  const [room, setRoom] = useState<HTMLElement | null>(null);
  const [words, setWords] = useState<HTMLElement | null>(null);
  const available = useWidth(room);
  const needed = useWidth(words);
  const fits = needed > 0 && available >= needed;
  return (
    <span ref={setRoom} className="min-w-0 flex-1 overflow-hidden pl-1.5">
      <span
        ref={setWords}
        aria-hidden={!fits || undefined}
        className={cn(
          "block w-max text-xs text-muted-foreground",
          !fits && "invisible",
        )}
      >
        {children}
      </span>
    </span>
  );
}
