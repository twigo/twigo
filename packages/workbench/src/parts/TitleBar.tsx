import type { ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Search,
  type LucideIcon,
} from "lucide-react";
import type { ContextColor, Space } from "@twigo/protocol";
import {
  cn,
  ContextDot,
  Kbd,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@twigo/ui";
import { useChanges, useWorkbench } from "../react";
import { onlyColor } from "./spaceBadge";
import type { Location } from "../views/registry";

const STRIP: Readonly<Record<ContextColor, string>> = {
  red: "bg-context-red",
  orange: "bg-context-orange",
  yellow: "bg-context-yellow",
  green: "bg-context-green",
  blue: "bg-context-blue",
  purple: "bg-context-purple",
};

const TOGGLES: readonly {
  location: Location;
  command: string;
  icon: LucideIcon;
}[] = [
  {
    location: "sidebar",
    command: "workbench.action.toggleSidebarVisibility",
    icon: PanelLeft,
  },
  {
    location: "panel",
    command: "workbench.action.togglePanel",
    icon: PanelBottom,
  },
  {
    location: "secondary",
    command: "workbench.action.toggleAuxiliaryBar",
    icon: PanelRight,
  },
];

/**
 * Where you are (ARCHITECTURE 4.2): the space and its namespace scope as a
 * breadcrumb that opens their pickers, the search that opens quick access,
 * and the part toggles. A space with one coloured context draws a strip.
 */
export function TitleBar() {
  const { spaces } = useWorkbench();
  useChanges(spaces.changes);
  const space = spaces.active;
  const color = space && onlyColor(space);
  return (
    <div className="shrink-0">
      {/* 36 px pairs with trafficLightPosition in tauri.conf.json: change both or neither. */}
      <header
        data-tauri-drag-region
        className="grid h-9 grid-cols-[1fr_minmax(0,28rem)_1fr] items-center gap-3 bg-shell pr-2 pl-[78px]"
      >
        <div className="flex min-w-0 items-center gap-0.5">
          {space && <Breadcrumb space={space} />}
        </div>
        <CommandCenter space={space} />
        <div className="flex justify-end gap-0.5">
          {TOGGLES.map((toggle) => (
            <PartToggle key={toggle.location} {...toggle} />
          ))}
        </div>
      </header>
      <div className={cn("h-0.5", color ? STRIP[color] : "bg-shell")} />
    </div>
  );
}

function Breadcrumb({ space }: { space: Space }) {
  const { spaces, quickAccess } = useWorkbench();
  const { namespaces } = spaces.state(space.id);
  const color = onlyColor(space);
  return (
    <>
      <Crumb label="Switch space" onClick={() => quickAccess.show("ctx ")}>
        {color && <ContextDot color={color} />}
        <span className="truncate font-medium">
          {space.contexts.map((context) => context.name).join(" + ")}
        </span>
      </Crumb>
      <ChevronRight
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground-2"
      />
      <Crumb label="Select namespace" onClick={() => quickAccess.show("ns ")}>
        <span className="truncate">
          {namespaces.length === 0 ? "All namespaces" : namespaces.join(", ")}
        </span>
      </Crumb>
    </>
  );
}

function Crumb({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors hover:bg-row-hover"
    >
      {children}
      <ChevronDown
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground"
      />
    </button>
  );
}

function CommandCenter({ space }: { space: Space | undefined }) {
  const { quickAccess, keybindings } = useWorkbench();
  useChanges(keybindings.changes);
  const binding = keybindings.primary("workbench.action.quickOpen");
  return (
    <button
      type="button"
      onClick={() => {
        quickAccess.show("");
      }}
      className="flex h-7 items-center gap-2 rounded-md border border-border bg-card/60 px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
    >
      <Search aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">Search {space?.name ?? "Twigo"}</span>
      {binding && (
        <Kbd className="ml-auto">{keybindings.label(binding.presses)}</Kbd>
      )}
    </button>
  );
}

function PartToggle({
  location,
  command,
  icon: Icon,
}: {
  location: Location;
  command: string;
  icon: LucideIcon;
}) {
  const { spaces, commands, keybindings, keys } = useWorkbench();
  const space = spaces.active;
  const visible = space
    ? spaces.state(space.id).parts[location].visible
    : false;
  const title = commands.get(command)?.title ?? command;
  const binding = keybindings.primary(command);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={title}
          aria-pressed={visible}
          onClick={() => {
            void commands.execute(command, keys.lookup(document.activeElement));
          }}
          className={cn(
            "flex size-7 items-center justify-center rounded-md transition-colors hover:bg-row-hover",
            visible ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <Icon className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-2">
        <span>{title}</span>
        {binding && (
          <span className="text-muted-foreground">
            {keybindings.label(binding.presses)}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
