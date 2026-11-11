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
            tone={words.warnings.length > 0 ? "warn" : "idle"}
            icon={<KindIcon words={words} className="size-3 shrink-0" />}
            className="max-w-full"
          >
            {/* A track of minmax(0, max-content) gives the words their own
                width but no minimum, so the strip's actions can give way
                before its tabs (styles.css in the workbench). */}
            <span className="grid grid-cols-[minmax(0,max-content)]">
              <span className="truncate">{words.short}</span>
            </span>
          </Pill>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <KindTip words={words} />
      </TooltipContent>
    </Tooltip>
  );
}
