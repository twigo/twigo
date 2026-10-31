import type { ReactNode } from "react";
import type { Space } from "@twigo/protocol";
import { cn, ContextDot } from "@twigo/ui";

interface Props {
  spaces: readonly Space[];
  active: string | undefined;
  onSelectSpace: (id: string) => void;
  children?: ReactNode;
}

export function Workbench({ spaces, active, onSelectSpace, children }: Props) {
  const current = spaces.find((space) => space.id === active);
  return (
    <div className="flex h-full flex-col">
      {/* 36 px pairs with trafficLightPosition in tauri.conf.json: change both or neither. */}
      <header
        data-tauri-drag-region
        role="tablist"
        aria-label="Spaces"
        className="flex h-9 shrink-0 items-center gap-1 border-b border-sidebar-border bg-sidebar pr-2 pl-[78px]"
      >
        {spaces.map((space) => (
          <SpaceTab
            key={space.id}
            space={space}
            selected={space.id === active}
            onSelect={() => {
              onSelectSpace(space.id);
            }}
          />
        ))}
      </header>
      <main className="min-h-0 flex-1">{children}</main>
      <footer className="flex h-[22px] shrink-0 items-center gap-3 bg-statusbar px-2.5 text-xs text-statusbar-foreground">
        {current && (
          <>
            <span className="flex items-center gap-1.5">
              <SpaceDot space={current} />
              {current.contexts.map((context) => context.name).join(" + ")}
            </span>
            <span className="opacity-80">all namespaces</span>
          </>
        )}
      </footer>
    </div>
  );
}

function SpaceTab({
  space,
  selected,
  onSelect,
}: {
  space: Space;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[13px] transition-colors duration-100",
        selected
          ? "border-[var(--tab-selected-border)] bg-[var(--tab-selected-bg)] text-foreground"
          : "border-transparent text-muted-foreground hover:bg-row-hover hover:text-foreground",
      )}
    >
      <SpaceDot space={space} />
      {space.name}
    </button>
  );
}

/** A space with one context shows that context's dot, if the user gave it a colour. */
function SpaceDot({ space }: { space: Space }) {
  const [only, ...more] = space.contexts;
  if (!only?.color || more.length > 0) return null;
  return <ContextDot color={only.color} />;
}
