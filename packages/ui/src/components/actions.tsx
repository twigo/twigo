import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, ChevronDown, Lock, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { rovingMove } from "../lib/roving";
import { useWidth } from "../lib/useWidth";
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
import { ButtonTip } from "./tip";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

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
  /** Why it cannot run, or, when locked, what the context's mode will answer. */
  readonly reason?: string;
  /**
   * The context's mode will refuse it: drawn dimmed with a lock, and it
   * still runs, so that the refusal can offer what lifts the lock.
   */
  readonly locked?: boolean;
  /** Kept in its place on a row of actions, before More. */
  readonly pinned?: boolean;
  /** A choice that is on or off, such as a shown column. */
  readonly checked?: boolean;
  readonly run: () => void;
}

/** Actions in groups, drawn with a separator between groups. */
export type ActionGroups = readonly (readonly Action[])[];

/**
 * A menu item's icon, label and keys, and under the label why it cannot run
 * or what its lock will answer. An item that says why stays opaque, so that
 * the reason reads, and fades only its own parts.
 */
function ItemBody({ action }: { action: Action }) {
  const Icon = action.icon;
  const faded = action.disabled === true && action.reason !== undefined;
  return (
    <>
      {action.checked !== undefined ? (
        <Check aria-hidden className={cn(!action.checked && "invisible")} />
      ) : (
        Icon && (
          <Icon
            aria-hidden
            className={cn(
              faded && "opacity-50",
              action.locked && "text-support",
            )}
          />
        )
      )}
      <span className="flex flex-1 flex-col">
        <span
          className={cn(faded && "opacity-50", action.locked && "text-support")}
        >
          {action.label}
        </span>
        {action.reason !== undefined && (
          <span className="flex items-center gap-1 text-2xs text-quiet">
            {action.locked && <Lock aria-hidden />}
            {action.reason}
          </span>
        )}
      </span>
      {action.keys && (
        <span
          className={cn("pl-4 text-2xs text-support", faded && "opacity-50")}
        >
          {action.keys}
        </span>
      )}
    </>
  );
}

/** A menu item that says why it is disabled keeps its own opacity: `ItemBody` fades its parts. */
const SAYS_WHY = "data-[disabled]:opacity-100";

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
                className={cn(action.reason !== undefined && SAYS_WHY)}
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
        onContextMenu={(event) => {
          // A right click in a row's menu would open the row's context menu.
          event.preventDefault();
        }}
      >
        {title && <DropdownMenuLabel>{title}</DropdownMenuLabel>}
        {actions.map((group, index) => (
          <Fragment key={group[0]?.id ?? index}>
            {index > 0 && <DropdownMenuSeparator />}
            {group.map((action) => (
              <DropdownMenuItem
                key={action.id}
                disabled={action.disabled}
                className={cn(
                  action.danger && "text-error",
                  action.reason !== undefined && SAYS_WHY,
                )}
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

/**
 * Actions with icons as a row of icon buttons; those without an icon, and
 * the disabled ones that give no reason, stay in menus. A disabled one with
 * a reason keeps its place and says why in its tooltip.
 */
export function InlineActions({
  actions,
  className,
}: {
  actions: readonly Action[];
  className?: string;
}) {
  const shown = actions.filter(
    (action): action is Action & { icon: LucideIcon } =>
      action.icon !== undefined &&
      (!action.disabled || action.reason !== undefined),
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
          disabled={action.disabled}
          locked={action.locked}
          reason={action.reason}
          onClick={action.run}
        />
      ))}
    </div>
  );
}

const BUTTON =
  "inline-flex h-6.5 shrink-0 items-center gap-1.5 rounded-md px-2 outline-none hover:bg-row-hover focus-visible:shadow-[var(--focus-ring)] [&_svg]:size-3.5";

/** How much of its action a button on a bar shows: all, all but the keys, or the icon alone. */
type Form = "full" | "label" | "icon";

/** A button's icon, its label unless the icon alone shows, its keys while they fit, and a lock where the mode will refuse it. */
function ButtonFace({ action, form }: { action: Action; form: Form }) {
  const Icon = action.icon;
  return (
    <>
      {Icon && <Icon aria-hidden />}
      {(form !== "icon" || !Icon) && action.label}
      {form === "full" && action.keys && <Kbd>{action.keys}</Kbd>}
      {action.locked && <Lock aria-hidden />}
    </>
  );
}

/** A tooltip over a bar's button that opens only when it has something to tell. */
function ButtonTooltip({
  action,
  told,
  children,
}: {
  action: Action;
  told: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip {...(!told && { open: false })}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="flex flex-col gap-0.5">
        <ButtonTip
          label={action.label}
          keys={action.keys}
          reason={action.reason}
          locked={action.locked}
        />
      </TooltipContent>
    </Tooltip>
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
        "flex items-center text-xs whitespace-nowrap",
        inline ? "gap-1" : "gap-0.5 rounded-lg bg-popover p-1 shadow-lg",
        className,
      )}
    >
      {children}
      {actions.map((group, index) => (
        <Fragment key={group[0]?.id ?? index}>
          {(index > 0 || children !== undefined) && (
            <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          )}
          {group.map((action) => (
            <ButtonTooltip
              key={action.id}
              action={action}
              told={action.reason !== undefined}
            >
              <button
                type="button"
                disabled={action.disabled}
                onClick={action.run}
                className={cn(
                  BUTTON,
                  "disabled:opacity-50",
                  action.danger && "text-error",
                  action.locked && "text-support",
                )}
              >
                <ButtonFace action={action} form="full" />
              </button>
            </ButtonTooltip>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

/** Below this much spare width a row keeps a stage it narrowed to, so that a width on a boundary does not flicker. */
const MARGIN = 16;

/**
 * The stage a row takes at `width` from `current`, where `needs` holds the
 * width each stage takes, the least collapsed first: it collapses as soon
 * as the current stage no longer fits, and comes back only with `MARGIN` to
 * spare. Until the row and every stage are measured it keeps `current`.
 */
function fitStage(
  width: number,
  needs: readonly number[],
  current: number,
): number {
  if (width <= 0 || needs.some((need) => need <= 0)) return current;
  const last = needs.length - 1;
  let stage = Math.min(current, last);
  while (stage < last && (needs[stage] ?? 0) > width) stage++;
  while (stage > 0 && (needs[stage - 1] ?? 0) + MARGIN <= width) stage--;
  return stage;
}

/** The form of the pinned action at `index` of `count` at `stage`: the keys go first, then the labels from the last one back. */
function formAt(stage: number, index: number, count: number): Form {
  if (stage === 0) return "full";
  return index >= count - (stage - 1) ? "icon" : "label";
}

/** A copy of the row at one stage, out of sight, whose width says what that stage takes. */
function Measured({
  stage,
  onMeasure,
  children,
}: {
  stage: number;
  onMeasure: (stage: number, width: number) => void;
  children: ReactNode;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const width = useWidth(element);
  useEffect(() => {
    onMeasure(stage, width);
  }, [onMeasure, stage, width]);
  return (
    <div
      ref={setElement}
      data-stage={stage}
      className="flex w-max items-center gap-1"
    >
      {children}
    </div>
  );
}

const MORE = cn(BUTTON, "gap-1 data-[state=open]:bg-row-hover");

/**
 * An object's actions as one row (ARCHITECTURE 4.3): its pinned actions in
 * their places with their labels and keys, a disabled one saying why in its
 * tooltip, then More, always last, with the rest in their groups. As the row
 * narrows the keys go first, then the labels from the last pinned action
 * back. The row is one tab stop, and the arrows, Home and End move along it.
 */
export function ActionRow({
  actions,
  label,
  className,
}: {
  actions: ActionGroups;
  /** The toolbar's accessible name. */
  label: string;
  className?: string;
}) {
  const pinned = actions.flat().filter((action) => action.pinned === true);
  const rest = actions
    .map((group) => group.filter((action) => action.pinned !== true))
    .filter((group) => group.length > 0);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const width = useWidth(element);
  const [needs, setNeeds] = useState<Readonly<Record<number, number>>>({});
  const onMeasure = useCallback((stage: number, need: number) => {
    setNeeds((was) => (was[stage] === need ? was : { ...was, [stage]: need }));
  }, []);
  const stages = Array.from({ length: pinned.length + 2 }, (_, stage) => stage);
  const [stage, setStage] = useState(0);
  const fitted = fitStage(
    width,
    stages.map((at) => needs[at] ?? 0),
    stage,
  );
  if (fitted !== stage) setStage(fitted);
  const [active, setActive] = useState(0);
  const count = pinned.length + 1;
  const focused = Math.min(active, count - 1);
  const roving = (index: number) => ({
    tabIndex: index === focused ? 0 : -1,
    onFocus: () => {
      setActive(index);
    },
  });

  return (
    <div
      ref={setElement}
      role="toolbar"
      aria-label={label}
      onKeyDown={(event) => {
        // The row's own buttons; a key in More's menu, which React bubbles
        // here through its portal, is not one of them.
        const items = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            ":scope > button",
          ),
        ];
        const from = items.indexOf(event.target as HTMLElement);
        if (from < 0) return;
        const to = rovingMove(event.key, from, items.length);
        if (to === undefined) return;
        event.preventDefault();
        setActive(to);
        items[to]?.focus();
      }}
      className={cn(
        "relative flex min-w-0 items-center gap-1 text-xs whitespace-nowrap",
        className,
      )}
    >
      {pinned.map((action, index) => {
        const form = formAt(fitted, index, pinned.length);
        const hides =
          (form === "icon" && action.icon !== undefined) ||
          (form !== "full" && action.keys !== undefined);
        return (
          <ButtonTooltip
            key={action.id}
            action={action}
            told={hides || action.reason !== undefined}
          >
            <button
              type="button"
              aria-label={action.label}
              aria-disabled={action.disabled === true || undefined}
              {...roving(index)}
              onClick={() => {
                if (!action.disabled) action.run();
              }}
              className={cn(
                BUTTON,
                form === "icon" && action.icon && "px-1.5",
                action.danger && "text-error",
                action.locked && "text-support",
                action.disabled && "opacity-50 hover:bg-transparent",
              )}
            >
              <ButtonFace action={action} form={form} />
            </button>
          </ButtonTooltip>
        );
      })}
      <ActionDropdown actions={rest} label="More">
        <button type="button" {...roving(pinned.length)} className={MORE}>
          More
          <ChevronDown aria-hidden />
        </button>
      </ActionDropdown>
      <div
        aria-hidden
        inert
        className="invisible absolute top-0 left-0 h-0 overflow-hidden"
      >
        {stages.map((at) => (
          <Measured key={at} stage={at} onMeasure={onMeasure}>
            {pinned.map((action, index) => {
              const form = formAt(at, index, pinned.length);
              return (
                <span
                  key={action.id}
                  className={cn(
                    BUTTON,
                    form === "icon" && action.icon && "px-1.5",
                  )}
                >
                  <ButtonFace action={action} form={form} />
                </span>
              );
            })}
            <span className={MORE}>
              More
              <ChevronDown aria-hidden />
            </span>
          </Measured>
        ))}
      </div>
    </div>
  );
}
