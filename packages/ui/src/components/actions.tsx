import { Fragment, type ReactNode } from "react";
import { Check, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { IconButton } from "./icon-button";
import { Kbd } from "./kbd";

/**
 * Something the user can do, as one model for every place that offers it:
 * the workbench builds these from a menu's commands, and the renderers
 * below draw them as a context menu, a dropdown, inline buttons or a bar.
 */
export interface Action {
  readonly id: string;
  readonly label: string;
  readonly icon?: LucideIcon;
  /** The keys that run it, as the platform writes them: `⌘⌫`. */
  readonly keys?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** A choice that is on or off, such as a shown column. */
  readonly checked?: boolean;
  readonly run: () => void;
}

/** Actions in groups, drawn with a separator between groups. */
export type ActionGroups = readonly (readonly Action[])[];

function ItemBody({ action }: { action: Action }) {
  const Icon = action.icon;
  return (
    <>
      {action.checked !== undefined ? (
        <Check aria-hidden className={cn(!action.checked && "invisible")} />
      ) : (
        Icon && <Icon aria-hidden />
      )}
      <span className="flex-1">{action.label}</span>
      {action.keys && (
        <span className="pl-4 text-[11px] text-muted-foreground">
          {action.keys}
        </span>
      )}
    </>
  );
}

/** A right click on `children` opens the actions; none, and it is just `children`. */
export function ActionContextMenu({
  actions,
  onOpen,
  children,
}: {
  actions: ActionGroups;
  onOpen?: () => void;
  children: ReactNode;
}) {
  if (actions.length === 0) return children;
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
    >
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {actions.map((group, index) => (
          <Fragment key={group[0]?.id ?? index}>
            {index > 0 && <ContextMenuSeparator />}
            {group.map((action) => (
              <ContextMenuItem
                key={action.id}
                disabled={action.disabled}
                variant={action.danger ? "destructive" : "default"}
                onSelect={action.run}
              >
                <ItemBody action={action} />
              </ContextMenuItem>
            ))}
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The actions behind a trigger, such as a row's ⋯ or a toolbar's Group.
 * With `keepOpen` the menu stays open as choices toggle, so several take
 * one visit, as the choice of columns does.
 */
export function ActionDropdown({
  actions,
  label,
  title,
  align = "end",
  keepOpen = false,
  onOpen,
  children,
}: {
  actions: ActionGroups;
  /** The trigger's accessible name. */
  label: string;
  /** A heading inside the menu. */
  title?: string;
  align?: "start" | "end";
  keepOpen?: boolean;
  onOpen?: () => void;
  /** The trigger, rendered as the button itself. */
  children: ReactNode;
}) {
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
    >
      <DropdownMenuTrigger aria-label={label} asChild>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        {title && <DropdownMenuLabel>{title}</DropdownMenuLabel>}
        {actions.map((group, index) => (
          <Fragment key={group[0]?.id ?? index}>
            {index > 0 && <DropdownMenuSeparator />}
            {group.map((action) => (
              <DropdownMenuItem
                key={action.id}
                disabled={action.disabled}
                className={cn(action.danger && "text-error")}
                onSelect={(event) => {
                  if (keepOpen) event.preventDefault();
                  action.run();
                }}
              >
                <ItemBody action={action} />
              </DropdownMenuItem>
            ))}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Actions with icons as a row of icon buttons; those without an icon stay in menus. */
export function InlineActions({
  actions,
  className,
}: {
  actions: readonly Action[];
  className?: string;
}) {
  const shown = actions.filter(
    (action): action is Action & { icon: LucideIcon } =>
      action.icon !== undefined && !action.disabled,
  );
  if (shown.length === 0) return null;
  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      {shown.map((action) => (
        <IconButton
          key={action.id}
          icon={action.icon}
          label={action.label}
          keys={action.keys}
          onClick={action.run}
        />
      ))}
    </div>
  );
}

/** Actions as labelled buttons with their keys, as a selection's bar. */
export function ActionBar({
  actions,
  className,
  children,
}: {
  actions: ActionGroups;
  className?: string;
  /** What the bar is about, before the actions: `2 selected`. */
  children?: ReactNode;
}) {
  return (
    <div
      role="toolbar"
      className={cn(
        "flex items-center gap-0.5 rounded-lg bg-popover p-1 text-xs whitespace-nowrap shadow-lg",
        className,
      )}
    >
      {children}
      {actions.map((group, index) => (
        <Fragment key={group[0]?.id ?? index}>
          {(index > 0 || children !== undefined) && (
            <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          )}
          {group.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.id}
                type="button"
                disabled={action.disabled}
                onClick={action.run}
                className={cn(
                  "inline-flex h-6.5 items-center gap-1.5 rounded-md px-2 outline-none hover:bg-row-hover focus-visible:shadow-[var(--focus-ring)] disabled:opacity-50 [&_svg]:size-3.5",
                  action.danger && "text-error",
                )}
              >
                {Icon && <Icon aria-hidden />}
                {action.label}
                {action.keys && <Kbd>{action.keys}</Kbd>}
              </button>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}
