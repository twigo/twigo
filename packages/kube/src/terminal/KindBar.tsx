import { TriangleAlert } from "lucide-react";
import { Banner, Button } from "@twigo/ui";
import { variant } from "../variants";
import { KindIcon } from "./KindIcon";
import type { KindWords } from "./kind";

/**
 * What the terminal's kind shows above it: in `kind:line` always, in words,
 * and in `kind:icon` only the warning, since the icon has none to say it
 * with. The chip needs no bar.
 */
export function KindBar({
  words,
  restart,
}: {
  words: KindWords;
  restart: () => void;
}) {
  const chosen = variant("kind", ["chip", "icon", "line"]);
  if (chosen === "chip" || (chosen === "icon" && !words.warning)) return null;
  if (words.warning) {
    return (
      <Banner
        tone="warn"
        icon={TriangleAlert}
        title={words.warning.title}
        action={
          <Button size="sm" variant="outline" onClick={restart}>
            Restart
          </Button>
        }
      >
        {words.warning.detail}
      </Banner>
    );
  }
  return (
    <div className="flex min-h-6 flex-none items-start gap-2 border-b border-border-subtle bg-panel px-3 py-1 text-xs text-muted-foreground">
      <KindIcon words={words} className="mt-0.5 size-3.5 shrink-0" />
      <span>
        <span className="font-medium text-foreground">{words.short}.</span>{" "}
        {words.why}
      </span>
    </div>
  );
}
