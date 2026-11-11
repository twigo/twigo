import { Pill, Tooltip, TooltipContent, TooltipTrigger } from "@twigo/ui";
import { KindIcon, KindTip } from "./KindIcon";
import type { KindWords } from "./kind";

/** A terminal's kind as a chip at the right of the panel's tab strip. */
export function KindChip({ words }: { words: KindWords }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="rounded-full outline-none focus-visible:shadow-[var(--focus-ring)]"
        >
          <Pill
            tone={words.warning ? "warn" : "idle"}
            icon={<KindIcon words={words} className="size-3 shrink-0" />}
          >
            {words.short}
          </Pill>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <KindTip words={words} />
      </TooltipContent>
    </Tooltip>
  );
}
