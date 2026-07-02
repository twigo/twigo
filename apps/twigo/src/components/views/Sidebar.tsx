import { useState } from "react";
import { Search } from "lucide-react";
import { EmptyState } from "@twigo/ui";
import { useUi } from "@/store/ui";
import { useConnections } from "@/store/connections";
import { useActiveSpace } from "@/store/spaces";
import { getViews } from "@/shell/views";
import { getDomain, getDefaultDomainId } from "@/shell/domains";

export function Sidebar() {
  const activeView = useUi((s) => s.activeView);
  const activeContext = useConnections((s) => s.activeContext);
  const [filter, setFilter] = useState("");

  // The active space (top tab) decides the technology; its connection bar and
  // views follow. No switcher lives in the sidebar. A space whose domain is no
  // longer registered falls back to the default domain.
  const spaceDomain = useActiveSpace()?.domainId;
  const domainId =
    spaceDomain && getDomain(spaceDomain)
      ? spaceDomain
      : getDefaultDomainId();
  const domain = getDomain(domainId);
  const ConnectionBar = domain?.ConnectionBar;

  // Resolve within the active domain: fall back to its default (then first) view
  // if the persisted one belongs to another domain or is gone.
  const views = getViews(domainId);
  const view =
    views.find((v) => v.id === activeView) ??
    views.find((v) => v.default) ??
    views[0];
  const title = view?.title ?? "";
  const icon = view?.icon ?? Search;
  const Panel = view?.Panel;

  return (
    <aside className="flex h-full w-full flex-col border-r border-sidebar-border bg-sidebar">
      {ConnectionBar && <ConnectionBar />}

      <div className="my-1.5 border-t border-sidebar-border" />

      <div className="flex items-baseline gap-1.5 px-3 pb-1">
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        {domainId === "nats" && activeContext && (
          <span className="truncate font-mono text-[11px] text-foreground/60">
            · {activeContext}
          </span>
        )}
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
          <Panel filter={filter} connId={activeContext ?? null} />
        ) : (
          <EmptyState density="inline" icon={icon}>
            {title} is on the roadmap - not available yet.
          </EmptyState>
        )}
      </div>
    </aside>
  );
}
