import { HELM_RELEASES } from "@twigo/protocol";
import {
  CutInTheMiddle,
  StatusDot,
  TonedText,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  type Tone,
} from "@twigo/ui";
import { KindIcon } from "../KindIcon";
import { IN_FLIGHT_RELEASE, isQuiet, problemWords, UNREADABLE } from "./status";

/** Head and tail of a chart together never go under this. */
const CHART_FLOOR = 12;

/** What the line says of a release that waits or cannot be read, in place of what its dot says alone. */
function wordOf(
  status: string,
  problem: string | undefined,
): { word: string; why?: string } | undefined {
  if (status === UNREADABLE) {
    const { word, why } = problemWords(problem ?? "");
    return { word, why };
  }
  return IN_FLIGHT_RELEASE.test(status) ? { word: status } : undefined;
}

/**
 * A release as one line that fits a side bar, as a forward's does: its
 * status's dot, the Helm icon, the name, the chart in the support role, the
 * words of the status where the release waits or cannot be read, and the
 * namespace at the end while the scope is every namespace. What follows the
 * name wraps onto a line the row clips, so the namespace goes first and the
 * words next, each whole or not at all; a chart wider than the room is alone
 * on its line and cut in the middle, and the name is cut last. The tooltip
 * has what the line leaves out. The row's ⋯ lies over the line's end, so the
 * namespace goes, whole, while the ⋯ shows.
 */
export function ReleaseLine({
  name,
  chart,
  namespace,
  says,
  status,
  problem,
  tone,
}: {
  name: string;
  chart: string;
  namespace: string;
  /** Whether the line says the namespace, as it does while the scope is every namespace. */
  says: boolean;
  status: string;
  /** The code in the row's Problem column. */
  problem: string | undefined;
  tone: Tone | undefined;
}) {
  const said = wordOf(status, problem);
  const shown = tone ?? (isQuiet(status) ? "idle" : "ok");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex w-full min-w-0 items-center align-top">
          <StatusDot
            tone={shown}
            pulse={IN_FLIGHT_RELEASE.test(status)}
            className="mr-1.5"
            {...(said === undefined && { label: status })}
          />
          <KindIcon
            gvr={HELM_RELEASES}
            className="mr-1.5 size-3.5 shrink-0 text-support"
          />
          <span className="min-w-0 truncate text-content">{name}</span>
          <span className="ml-1.5 flex h-4.5 min-w-0 flex-1 flex-wrap gap-x-1.5 overflow-hidden">
            {chart !== "" && (
              <span className="min-w-0 text-support">
                <CutInTheMiddle
                  text={chart}
                  floor={CHART_FLOOR}
                  separator="-"
                />
              </span>
            )}
            {said && (
              <span className="text-xs whitespace-nowrap text-support">
                {said.word}
              </span>
            )}
            {says && (
              <span className="ml-auto whitespace-nowrap text-quiet group-hover/row:opacity-0 group-focus-within/row:opacity-0 group-has-[[data-state=open]]/row:opacity-0">
                {namespace}
              </span>
            )}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="grid gap-0.5 break-words">
        <span>Helm release {name}</span>
        <span className="text-support">
          {[chart, namespace].filter((part) => part !== "").join(" · ")}
        </span>
        <span>
          <TonedText tone={shown}>{said?.word ?? status}</TonedText>
          {said?.why !== undefined && (
            <span className="text-support"> · {said.why}</span>
          )}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
