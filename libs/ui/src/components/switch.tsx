import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

import { cn } from "../lib/cn";

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border border-transparent outline-none transition-colors focus-visible:shadow-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-brand data-[state=unchecked]:bg-input",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform",
          "data-[state=checked]:translate-x-[15px] data-[state=unchecked]:translate-x-0.5",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
