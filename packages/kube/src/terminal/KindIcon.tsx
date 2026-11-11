import { KeyRound, ShieldCheck, TriangleAlert } from "lucide-react";
import type { KindWords } from "./kind";

/** The icon that says a terminal's kind: the proxy's, real credentials', or a warning's. */
export function KindIcon({
  words,
  className,
}: {
  words: KindWords;
  className?: string;
}) {
  if (words.warning) return <TriangleAlert aria-hidden className={className} />;
  return words.credentials === "own" ? (
    <KeyRound aria-hidden className={className} />
  ) : (
    <ShieldCheck aria-hidden className={className} />
  );
}

/** What a hover over the kind says: the warning first. */
export function KindTip({ words }: { words: KindWords }) {
  return (
    <>
      <div className="font-medium">
        {words.warning ? words.warning.title : words.short}
      </div>
      <div className="text-muted-foreground">
        {words.warning ? words.warning.detail : words.why}
      </div>
    </>
  );
}
