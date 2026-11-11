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
  if (words.warnings.length > 0) {
    return <TriangleAlert aria-hidden className={className} />;
  }
  return words.credentials === "own" ? (
    <KeyRound aria-hidden className={className} />
  ) : (
    <ShieldCheck aria-hidden className={className} />
  );
}

/** What a hover over the kind says: the kind and why, then its warnings. */
export function KindTip({ words }: { words: KindWords }) {
  const notes = [{ title: words.short, detail: words.why }, ...words.warnings];
  return (
    <div className="grid gap-1.5">
      {notes.map(({ title, detail }) => (
        <div key={title}>
          <div className="font-medium">{title}</div>
          <div className="text-muted-foreground">{detail}</div>
        </div>
      ))}
    </div>
  );
}
