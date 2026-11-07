import { useState } from "react";
import { Lock, LockOpen, ShieldAlert } from "lucide-react";
import type { ContextAccess, Environment, Mode } from "@twigo/protocol";
import {
  Button,
  LinkButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Segmented,
} from "@twigo/ui";
import { useChanges, useWorkbench } from "../react";
import {
  RELOCK_CONTEXT,
  SET_CONTEXT_ENVIRONMENT,
  SET_CONTEXT_MODE,
  UNLOCK_CONTEXT,
  type SetArgs,
} from "../spaces/modeCommands";
import {
  accessOfSpace,
  chipLabel,
  describeAccess,
  ENVIRONMENTS,
  environmentLabel,
  MODES,
  modeHelp,
  modeLabel,
  setByPolicyFile,
} from "../spaces/modes";

const NO_TYPE = "none";
type TypeChoice = Environment | typeof NO_TYPE;

/**
 * The mode after the context's name (ARCHITECTURE 6.4), in the context's
 * colour, as NN/g asks of a mode: say it where you are looking. It opens
 * what set it, and the choices the person has. A context nobody marked
 * that lets everything through has no chip.
 */
export function ModeChip() {
  const { spaces, catalog } = useWorkbench();
  useChanges(spaces.changes);
  useChanges(catalog.changes);
  const space = spaces.active;
  const access = space && accessOfSpace(catalog, space);
  const [context] = space?.contexts ?? [];
  const label = access && chipLabel(access);
  if (!access || !label || context === undefined) return null;
  // Its own state per context, so a popover left open on one never opens on
  // the next.
  return <Chip key={context} context={context} access={access} label={label} />;
}

function Chip({
  context,
  access,
  label,
}: {
  context: string;
  access: ContextAccess;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const Icon = access.unlockedUntil
    ? LockOpen
    : access.mode === "read-only"
      ? Lock
      : access.mode === "guarded"
        ? ShieldAlert
        : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Mode of ${context}: ${label}`}
          className="twigo-mode-chip mx-1 flex h-5 shrink-0 items-center gap-1 rounded px-[7px] text-[11px] font-semibold whitespace-nowrap outline-none focus-visible:shadow-[var(--focus-ring)]"
        >
          {Icon && <Icon aria-hidden className="size-3" />}
          {label}
        </button>
      </PopoverTrigger>
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
  const locked = setByPolicyFile(access.source);
  const run = (command: string, args: unknown) => {
    void commands.execute(command, keys.lookup(null), args);
  };
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <div className="font-medium">{context}</div>
        <div className="text-muted-foreground">{modeHelp(access.mode)}</div>
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
            value={access.mode}
            onChange={(value) => {
              // The pressed one changes nothing: pressing the guarded of an
              // unlock would end its relock for good.
              if (value === access.mode) return;
              const args: SetArgs<Mode> = { context, value };
              run(SET_CONTEXT_MODE, args);
            }}
          />
        )}
      </Row>
      <Row label="Type">
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
      </Row>
      <div className="text-muted-foreground">
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
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
