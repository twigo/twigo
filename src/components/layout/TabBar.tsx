import { X, Radio } from "lucide-react";
import { cn } from "@/lib/utils";

const tabs = [
  { id: "t1", label: "orders.>", active: true },
  { id: "t2", label: "payments.captured", active: false },
];

export function TabBar() {
  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-panel">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={cn(
            "group flex items-center gap-1.5 border-r border-border px-3 text-xs",
            t.active
              ? "bg-background text-foreground"
              : "text-muted-foreground hover:bg-accent/50",
          )}
        >
          {t.active && (
            <span className="absolute -mt-[34px] h-0.5 w-[inherit] bg-brand" />
          )}
          <Radio className="size-3.5 text-brand" />
          <span className="font-mono">{t.label}</span>
          <button
            type="button"
            aria-label={`Close ${t.label}`}
            className="ml-1 rounded p-0.5 opacity-0 hover:bg-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
