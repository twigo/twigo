import { Terminal } from "lucide-react";
import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@twigo/ui";
import { useChanges } from "@twigo/workbench";
import { variant } from "../variants";
import { KindIcon, KindTip } from "./KindIcon";
import type { TerminalTabs } from "./tabs";
import { useKind } from "./useKind";

/** A terminal tab's icon, which in `kind:icon` says the kind. */
export function KindTabIcon({
  uri,
  tabs,
  className,
}: {
  uri: string;
  tabs: TerminalTabs;
  className?: string;
}) {
  useChanges(tabs.changes);
  const words = useKind(tabs.get(uri));
  if (variant("kind", ["chip", "icon", "line"]) !== "icon" || !words) {
    return <Terminal className={className} />;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex">
          <KindIcon
            words={words}
            className={cn(className, words.warning && "text-warn-foreground")}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <KindTip words={words} />
      </TooltipContent>
    </Tooltip>
  );
}
