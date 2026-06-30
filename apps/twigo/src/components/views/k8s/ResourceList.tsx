import { Circle, type LucideIcon } from "lucide-react";
import { cn, EmptyState } from "@twigo/ui";

// Shared dense list for every Kubernetes resource view: a status dot, a
// monospace name, and a right-aligned meta column. Mirrors the NATS views' look.

export type K8sStatus = "ok" | "warn" | "error" | "idle";

export interface ResourceRow {
  id: string;
  name: string;
  status: K8sStatus;
  meta: string;
}

const DOT: Record<K8sStatus, string> = {
  ok: "fill-ok text-ok",
  warn: "fill-warn text-warn animate-pulse",
  error: "fill-error text-error",
  idle: "fill-muted-foreground/40 text-muted-foreground/40",
};

export function ResourceList({
  rows,
  filter,
  icon,
  noun,
}: {
  rows: ResourceRow[];
  filter: string;
  icon: LucideIcon;
  noun: string;
}) {
  const q = filter.trim().toLowerCase();
  const shown = q
    ? rows.filter((r) => r.name.toLowerCase().includes(q))
    : rows;

  if (shown.length === 0) {
    return (
      <EmptyState density="inline" icon={icon}>
        {q ? `No ${noun} match "${filter}".` : `No ${noun} found.`}
      </EmptyState>
    );
  }

  return (
    <ul className="flex flex-col gap-px py-0.5">
      {shown.map((r) => (
        <li
          key={r.id}
          className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-row-hover"
        >
          <Circle aria-hidden className={cn("size-2 shrink-0", DOT[r.status])} />
          <span className="min-w-0 flex-1 truncate font-mono text-foreground/90">
            {r.name}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {r.meta}
          </span>
        </li>
      ))}
    </ul>
  );
}
