import { useState, type ComponentProps } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@twigo/ui";

/**
 * A tab's root element with its tooltip. The tooltip is asked for each time
 * it opens, since what it says, a space's namespace scope among it, changes
 * while the tab stays.
 */
export function TabTooltip({
  tooltip,
  ...props
}: ComponentProps<"div"> & { tooltip: () => string | undefined }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string>();
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        const asked = next ? tooltip() : undefined;
        if (asked !== undefined) setText(asked);
        setOpen(asked !== undefined);
      }}
    >
      <TooltipTrigger asChild>
        <div {...props} />
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="wrap-anywhere">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
