import { Fragment, useRef, type ReactNode } from "react";
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

/**
 * Runs the chosen action as its menu closes, once the focus is back where
 * it was before the menu opened, as VS Code runs a context menu's action:
 * an open menu holds the focus, so an action that opens a picker or a
 * dialog would lose it, and would read the context keys of the menu
 * rather than of the element the menu was opened on. Radix reports the
 * close after the render that released the menu's focus trap, and the
 * action runs then, not after the close animation, so a menu opened
 * again meanwhile cannot change what it acts on.
 */
function useRunOnClose() {
  const chosen = useRef<Action>(undefined);
  const ran = useRef(false);
  const open = useRef(false);
  return {
    // A closing menu's items still take clicks while it fades out.
    choose: (action: Action) => {
      if (open.current) chosen.current = action;
    },
    opened: (menu: HTMLElement | null) => {
      open.current = true;
      ran.current = false;
      // Opened again while it fades out, the menu keeps its content, which
      // Radix focuses only as it mounts.
      if (menu && !menu.contains(document.activeElement)) menu.focus();
    },
    closed: (back: HTMLElement | null) => {
      open.current = false;
      const action = chosen.current;
      chosen.current = undefined;
      if (!action) return;
      back?.focus();
      ran.current = true;
      action.run();
    },
    onCloseAutoFocus: (event: Event) => {
      // The action left the focus where it belongs, perhaps in a picker.
      if (ran.current) event.preventDefault();
      ran.current = false;
    },
  };
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
  const run = useRunOnClose();
  const back = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  if (actions.length === 0) return children;
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (!open) {
          run.closed(back.current);
          return;
        }
        run.opened(content.current);
        onOpen?.();
      }}
    >
      <ContextMenuTrigger
        asChild
        onContextMenuCapture={(event) => {
          // A right click while the menu is still shown moves it; the focus
          // it had before it opened stays where to go back.
          if (content.current) return;
          const active = document.activeElement;
          // Another menu that held the focus is going away with it, and
          // nothing may hold it at all.
          back.current =
            active instanceof HTMLElement &&
            active !== document.body &&
            !active.closest('[role="menu"]')
              ? active
              : event.currentTarget.closest<HTMLElement>("[tabindex]");
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent ref={content} onCloseAutoFocus={run.onCloseAutoFocus}>
        {actions.map((group, index) => (
          <Fragment key={group[0]?.id ?? index}>
            {index > 0 && <ContextMenuSeparator />}
            {group.map((action) => (
              <ContextMenuItem
                key={action.id}
                disabled={action.disabled}
                variant={action.danger ? "destructive" : "default"}
                onSelect={() => {
                  run.choose(action);
                }}
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
  const run = useRunOnClose();
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) {
          run.closed(trigger.current);
          return;
        }
        run.opened(content.current);
        onOpen?.();
      }}
    >
      <DropdownMenuTrigger ref={trigger} aria-label={label} asChild>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={content}
        align={align}
        onCloseAutoFocus={run.onCloseAutoFocus}
      >
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
                  if (keepOpen) {
                    event.preventDefault();
                    action.run();
                  } else {
                    run.choose(action);
                  }
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

/**
 * Actions as labelled buttons with their keys: a selection's floating bar,
 * or `inline` in a panel's header, as the details' actions.
 */
export function ActionBar({
  actions,
  inline = false,
  className,
  children,
}: {
  actions: ActionGroups;
  inline?: boolean;
  className?: string;
  /** What the bar is about, before the actions: `2 selected`. */
  children?: ReactNode;
}) {
  return (
    <div
      role="toolbar"
      className={cn(
        "flex items-center gap-0.5 text-xs whitespace-nowrap",
        !inline && "rounded-lg bg-popover p-1 shadow-lg",
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
