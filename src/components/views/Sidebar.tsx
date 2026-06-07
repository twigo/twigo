import { useState } from "react";
import { Search } from "lucide-react";
import { useUi } from "@/store/ui";
import { ConnectionsList } from "@/components/connections/ConnectionsList";
import { VIEWS } from "./registry";

export function Sidebar() {
  const activeView = useUi((s) => s.activeView);
  const [filter, setFilter] = useState("");
  const { title, Panel } = VIEWS[activeView];

  return (
    <aside className="flex h-full w-full flex-col border-r border-sidebar-border bg-sidebar">
      <ConnectionsList />

      <div className="my-1.5 border-t border-sidebar-border" />

      <div className="px-3 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
      </div>
      <div className="px-2 pb-1.5">
        <div className="flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label={`Filter ${title}`}
            placeholder="Filter…"
            className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {Panel ? (
          <Panel filter={filter} />
        ) : (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            {title} — coming soon.
          </p>
        )}
      </div>
    </aside>
  );
}
