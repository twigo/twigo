import { useState } from "react";
import { Lock, LockOpen, RotateCcw, ShieldAlert, Tag } from "lucide-react";
import type { ContextAccess, Environment, Mode } from "@twigo/protocol";
import {
  Button,
  cn,
  LinkButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Segmented,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@twigo/ui";
import { useChanges, useWorkbench } from "../react";
import {
  RELOCK_CONTEXT,
  SET_CONTEXT_ENVIRONMENT,
  SET_CONTEXT_MODE,
  START_OVER_PROTECTION,
  UNLOCK_CONTEXT,
  type SetArgs,
} from "../spaces/modeCommands";
import {
  accessOfSpace,
  chipLabel,
  currentMode,
  describeAccess,
  ENVIRONMENTS,
  environmentLabel,
  MODES,
  modeHelp,
  modeLabel,
  unchangeable,
} from "../spaces/modes";

const NO_TYPE = "none";
type TypeChoice = Environment | typeof NO_TYPE;

const CHIP =
  "mx-1 flex h-5 shrink-0 items-center gap-1 rounded-sm px-[7px] text-2xs font-semibold whitespace-nowrap";

function useChip() {
  const { spaces, catalog } = useWorkbench();
  useChanges(spaces.changes);
  useChanges(catalog.changes);
  const space = spaces.active;
  const access = space && accessOfSpace(catalog, space);
  const [context] = space?.contexts ?? [];
  const label = access && chipLabel(access);
  return access && label && context !== undefined
    ? { access, label, context }
    : undefined;
}

/**
 * The mode after the context's name (ARCHITECTURE 6.4), in the context's
 * colour, as NN/g asks of a mode: say it where you are looking. It opens
 * what set it, and the choices the person has; a context nobody marked has a
 * quiet one. Folded, it is its icon, and its words are the tooltip.
 */
export function ModeChip({ folded }: { folded: boolean }) {
  const chip = useChip();
  if (!chip) return null;
  // Its own state per context, so a popover left open on one never opens on
  // the next.
  return <Chip key={chip.context} {...chip} folded={folded} />;
}

/** The chip with its words as the title bar's hidden copy, to measure what it takes. */
export function ModeChipCopy() {
  const chip = useChip();
  return (
    chip && (
      <span className={CHIP}>
        <ChipFace access={chip.access} label={chip.label} folded={false} />
      </span>
    )
  );
}

function ChipFace({
  access,
  label,
  folded,
}: {
  access: ContextAccess;
  label: string;
  folded: boolean;
}) {
  const Icon = access.unlockedUntil
    ? LockOpen
    : access.source.kind === "unmarked"
      ? Tag
      : access.mode === "read-only"
        ? Lock
        : access.mode === "guarded"
          ? ShieldAlert
          : undefined;
  const Shown = Icon ?? (folded ? Tag : undefined);
  return (
    <>
      {Shown && <Shown aria-hidden className="size-3" />}
      {!folded && label}
    </>
  );
}

function Chip({
  context,
  access,
  label,
  folded,
}: {
  context: string;
  access: ContextAccess;
  label: string;
  folded: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`Mode of ${context}: ${label}`}
              className={cn(
                "outline-none focus-visible:shadow-[var(--focus-ring)]",
                access.source.kind === "unmarked"
                  ? "bg-well text-support"
                  : "twigo-mode-chip",
                CHIP,
                folded && "w-5 justify-center px-0",
              )}
            >
              <ChipFace access={access} label={label} folded={folded} />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        {folded && <TooltipContent>{label}</TooltipContent>}
      </Tooltip>
      <PopoverContent
        aria-label={`Mode of ${context}`}
        className="w-[26rem] p-3 text-xs"
        // Radix focuses the first control, Read-write, where a second Enter
        // would open up a production context.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus({
            preventScroll: true,
          });
        }}
      >
        <ModeDetails context={context} access={access} />
      </PopoverContent>
    </Popover>
  );
}

function ModeDetails({
  context,
  access,
}: {
  context: string;
  access: ContextAccess;
}) {
  const { commands, keys } = useWorkbench();
  const locked = unchangeable(access.source);
  const unread = access.source.kind === "protectionUnreadable";
  const run = (command: string, args: unknown) => {
    void commands.execute(command, keys.lookup(null), args);
  };
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <div className="font-medium">{context}</div>
        <div className="text-support">{modeHelp(access.mode)}</div>
      </div>
      <Row label="Mode">
        {locked ? (
          <span className="font-medium">{modeLabel(access.mode)}</span>
        ) : (
          <Segmented<Mode>
            label="Mode"
            items={MODES.map((mode) => ({
              value: mode,
              label: modeLabel(mode),
            }))}
            value={currentMode(access)}
            onChange={(value) => {
              // The pressed one changes nothing: pressing the guarded of an
              // unlock would end its relock for good.
              if (value === currentMode(access)) return;
              const args: SetArgs<Mode> = { context, value };
              run(SET_CONTEXT_MODE, args);
            }}
          />
        )}
      </Row>
      <Row label="Type">
        {unread ? (
          <span className="font-medium">
            {access.environment === null
              ? "None"
              : environmentLabel(access.environment)}
          </span>
        ) : (
          <Segmented<TypeChoice>
            label="Type"
            items={[
              { value: NO_TYPE, label: "None" },
              ...ENVIRONMENTS.map((environment) => ({
                value: environment,
                label: environmentLabel(environment),
              })),
            ]}
            value={access.environment ?? NO_TYPE}
            onChange={(value) => {
              if (value === (access.environment ?? NO_TYPE)) return;
              const args: SetArgs<Environment> = {
                context,
                value: value === NO_TYPE ? null : value,
              };
              run(SET_CONTEXT_ENVIRONMENT, args);
            }}
          />
        )}
      </Row>
      <div className="text-support">
        {describeAccess(access)}
        {access.source.kind === "user" && (
          <>
            {" "}
            <LinkButton
              onClick={() => {
                const args: SetArgs<Mode> = { context, value: null };
                run(SET_CONTEXT_MODE, args);
              }}
            >
              Use the default
            </LinkButton>
          </>
        )}
      </div>
      {unread && (
        <Button
          size="sm"
          variant="outline"
          className="justify-self-start"
          onClick={() => {
            run(START_OVER_PROTECTION, undefined);
          }}
        >
          <RotateCcw aria-hidden className="size-3.5" />
          Start Over…
        </Button>
      )}
      {access.mode === "read-only" && !locked && (
        <Button
          size="sm"
          variant="outline"
          className="justify-self-start"
          onClick={() => {
            run(UNLOCK_CONTEXT, undefined);
          }}
        >
          <LockOpen aria-hidden className="size-3.5" />
          Unlock for 15 minutes
        </Button>
      )}
      {access.unlockedUntil !== null && (
        <Button
          size="sm"
          variant="outline"
          className="justify-self-start"
          onClick={() => {
            run(RELOCK_CONTEXT, undefined);
          }}
        >
          <Lock aria-hidden className="size-3.5" />
          Lock now
        </Button>
      )}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-2">
      <span className="text-support">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
