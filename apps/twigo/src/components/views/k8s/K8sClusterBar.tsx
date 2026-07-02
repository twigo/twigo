import { useState } from "react";
import { Check, ChevronsUpDown, Circle } from "lucide-react";
import { cn, Popover, PopoverTrigger, PopoverContent } from "@twigo/ui";
import { CLUSTERS } from "@/modules/k8s/mock";
import { useCluster } from "@/modules/k8s/cluster";

// The Kubernetes domain's connection bar: pick the active kubeconfig context.
// Mock for the MVP - a real module would list kubeconfig contexts and track
// reachability, mirroring the NATS ConnectionSwitcher. Shares the cluster
// store with the space-tab target hook, so tabs and this bar stay in sync.
export function K8sClusterBar() {
  const [open, setOpen] = useState(false);
  const active = useCluster((s) => s.selected);
  const setActive = useCluster((s) => s.select);

  return (
    <div className="px-2 pb-1 pt-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Switch cluster"
            className="flex h-8 w-full items-center gap-2 rounded-md border border-input bg-background px-2 text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Circle aria-hidden className="size-2 shrink-0 fill-ok text-ok" />
            <span className="min-w-0 flex-1 truncate text-left font-medium">
              {active}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[var(--radix-popover-trigger-width)] min-w-64 p-1"
        >
          <ul className="flex flex-col gap-px">
            {CLUSTERS.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  onClick={() => {
                    setActive(name);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-row-hover"
                >
                  <Circle
                    aria-hidden
                    className="size-2 shrink-0 fill-ok text-ok"
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {name}
                  </span>
                  <Check
                    className={cn(
                      "size-3.5 shrink-0 text-brand",
                      active === name ? "opacity-100" : "opacity-0",
                    )}
                  />
                </button>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}
