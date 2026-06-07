import * as ResizablePrimitive from "react-resizable-panels";

import { cn } from "@/lib/utils";

function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({
  className,
  ...props
}: ResizablePrimitive.SeparatorProps) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        // wide, transparent grab zone with a centered 1px line
        "group relative flex w-1.5 items-center justify-center bg-transparent outline-none focus-visible:ring-1 focus-visible:ring-ring aria-[orientation=horizontal]:h-1.5 aria-[orientation=horizontal]:w-full",
        className,
      )}
      {...props}
    >
      <div className="h-full w-px bg-border transition-colors group-hover:bg-brand group-aria-[orientation=horizontal]:h-px group-aria-[orientation=horizontal]:w-full" />
    </ResizablePrimitive.Separator>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
