import { useRef, useState, type ComponentProps } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@twigo/ui";

/**
 * A tab's root element with its tooltip. The tooltip is asked for each time
 * it opens, since what it says, a space's namespace scope among it, changes
 * while the tab stays. While a button is down on the tab it stays shut, since
 * a press held past the delay is the start of a drag, and the content takes
 * no pointer so that it cannot sit over where the tab is dropped.
 */
export function TabTooltip({
  tooltip,
  ...props
}: ComponentProps<"div"> & { tooltip: () => string | undefined }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string>();
  const pressed = useRef(false);
  const release = () => {
    pressed.current = false;
  };
  return (
    <Tooltip
      open={open}
      disableHoverableContent
      onOpenChange={(next) => {
        const asked = next && !pressed.current ? tooltip() : undefined;
        if (asked !== undefined) setText(asked);
        setOpen(asked !== undefined);
      }}
    >
      <TooltipTrigger asChild>
        <div
          {...props}
          onPointerDown={() => {
            pressed.current = true;
          }}
          onPointerUp={release}
          onPointerCancel={release}
          onPointerLeave={release}
        />
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="start"
        className="pointer-events-none wrap-anywhere"
      >
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
