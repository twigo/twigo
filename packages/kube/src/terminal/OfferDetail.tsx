import { Fragment } from "react";
import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@twigo/ui";
import { nameParts, type OfferName, type OfferWords } from "./offerWords";

function Name({ name }: { name: string }) {
  return (
    <code className="font-mono select-text">
      {nameParts(name).map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <wbr />}
          <span className="inline-block max-w-full wrap-anywhere">{part}</span>
        </Fragment>
      ))}
    </code>
  );
}

function Line({ entry }: { entry: OfferName }) {
  return (
    <div className={cn("min-w-0", entry.leftOut && "text-muted-foreground")}>
      <Name name={entry.name} />
      <span className="text-muted-foreground"> · {entry.kinds}</span>
    </div>
  );
}

export function OfferDetail({ words }: { words: OfferWords }) {
  return (
    <div className="grid gap-1 text-[11px] leading-4">
      <div className="grid gap-0.5">
        {words.names.map((entry) => (
          <Line key={entry.name} entry={entry} />
        ))}
        {words.more !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="justify-self-start rounded text-muted-foreground underline decoration-dotted underline-offset-2 outline-none hover:text-foreground focus-visible:shadow-[var(--focus-ring)]"
              >
                {words.more}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="grid gap-0.5 text-[11px]">
              {words.all.map((entry) => (
                <Line key={entry.name} entry={entry} />
              ))}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {words.reason !== undefined && (
        <span className="text-muted-foreground">{words.reason}</span>
      )}
    </div>
  );
}
