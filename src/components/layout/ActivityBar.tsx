import {
  Radio,
  Layers,
  Database,
  Box,
  Activity,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useUi, type View } from "@/store/ui";

const items: { view: View; label: string; icon: typeof Radio }[] = [
  { view: "subjects", label: "Subjects", icon: Radio },
  { view: "jetstream", label: "JetStream", icon: Layers },
  { view: "kv", label: "KV Store", icon: Database },
  { view: "objectstore", label: "Object Store", icon: Box },
  { view: "monitor", label: "Monitoring", icon: Activity },
];

export function ActivityBar() {
  const { activeView, setView } = useUi();
  return (
    <nav className="flex h-full w-12 shrink-0 flex-col items-center justify-between border-r border-sidebar-border bg-sidebar py-2">
      <div className="flex flex-col items-center gap-1">
        {items.map(({ view, label, icon: Icon }) => {
          const active = activeView === view;
          return (
            <button
              key={view}
              title={label}
              onClick={() => setView(view)}
              className={cn(
                "relative flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                active && "text-foreground",
              )}
            >
              {active && (
                <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-brand" />
              )}
              <Icon className="size-5" />
            </button>
          );
        })}
      </div>
      <button
        title="Settings"
        className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Settings className="size-5" />
      </button>
    </nav>
  );
}
