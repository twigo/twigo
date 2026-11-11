import { cn } from "@twigo/ui";
import type { OfferSection, OfferWords } from "./offerWords";

function Sections({
  title,
  sections,
}: {
  title: string;
  sections: readonly OfferSection[];
}) {
  return (
    <div className="grid content-start gap-1">
      <span className="text-muted-foreground">{title}</span>
      {sections.map(({ label, names, reason }) => (
        <div key={label} className="grid gap-x-2 @lg:grid-cols-[4.5rem_1fr]">
          <span className="font-medium">{label}</span>
          <div className="grid gap-0.5">
            {names.map((name) => (
              <code
                key={name}
                className="font-mono text-[11px] wrap-anywhere select-text"
              >
                {name}
              </code>
            ))}
            {reason !== undefined && (
              <span className="text-[11px] text-muted-foreground">
                {reason}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function OfferDetail({
  words,
  className,
}: {
  words: OfferWords;
  className: string;
}) {
  return (
    <div className={cn("@container overflow-y-auto", className)}>
      <div className="grid gap-1.5 @lg:grid-cols-2 @lg:gap-4">
        {words.moves.length > 0 && (
          <Sections title="A move writes" sections={words.moves} />
        )}
        {words.leaves.length > 0 && (
          <Sections title="A move leaves out" sections={words.leaves} />
        )}
      </div>
    </div>
  );
}
