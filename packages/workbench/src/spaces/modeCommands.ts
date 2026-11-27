import { Lock, LockOpen, RotateCcw, Shield, Tag } from "lucide-react";
import type { Environment, Mode, Space } from "@twigo/protocol";
import type { QuickPickItem } from "../quickaccess/registry";
import type { Workbench } from "../services";
import {
  currentMode,
  ENVIRONMENTS,
  environmentLabel,
  MODES,
  modeHelp,
  modeLabel,
} from "./modes";

export const SET_CONTEXT_MODE = "workbench.action.setContextMode";
export const SET_CONTEXT_ENVIRONMENT = "workbench.action.setContextEnvironment";
export const UNLOCK_CONTEXT = "workbench.action.unlockContext";
export const RELOCK_CONTEXT = "workbench.action.relockContext";
export const START_OVER_PROTECTION = "workbench.action.startOverProtection";

const NONE = "none";

/** A mode or a type to set outright, as the chip does; without one the command asks. */
export interface SetArgs<T> {
  readonly context: string;
  readonly value: T | null;
}

function isSetArgs<T>(args: unknown): args is SetArgs<T> {
  return typeof args === "object" && args !== null && "value" in args;
}

/**
 * A context's mode and type (ARCHITECTURE 6.4). Rust owns them: a change that
 * lowers protection is a plan of the command bus, which draws the friction
 * Rust names and is in the audit log, and the catalog's watch says what
 * follows. A relock only tightens, so it goes as it is. Starting over from
 * the person's protection file that cannot be read is such a plan too, on no
 * context, which the problem's notice and the access popover offer.
 */
export function registerContextModes(workbench: Workbench): void {
  const { commands, menus, spaces, catalog, quickAccess, backend, operations } =
    workbench;

  /** The context of the space the rail's menu names, or of the active one. */
  const contextOf = (args: unknown): string | undefined => {
    const space: Space | undefined =
      typeof args === "string"
        ? spaces.list.find((candidate) => candidate.id === args)
        : spaces.active;
    const [only, ...more] = space?.contexts ?? [];
    return more.length > 0 ? undefined : only;
  };

  commands.register({
    id: SET_CONTEXT_MODE,
    title: "Set Context Mode…",
    category: "Space",
    icon: Shield,
    enablement: "context.mode",
    run: async (args) => {
      if (isSetArgs<Mode>(args)) {
        await operations.run(
          { action: "setMode", context: args.context, mode: args.value },
          { icon: Shield },
        );
        return;
      }
      const context = contextOf(args);
      const access = context && catalog.find(context)?.access;
      if (!context || !access) return;
      const items: QuickPickItem[] = [
        ...MODES.map((mode) => ({
          id: mode,
          label: modeLabel(mode),
          description:
            mode === currentMode(access) ? "Current" : modeHelp(mode),
        })),
        {
          id: NONE,
          label: "Default",
          description: "What its type or kubeconfig says",
        },
      ];
      const picked = await quickAccess.pick(`Mode of ${context}`, items);
      // The current one changes nothing: picking the guarded of an unlock
      // would end its relock for good. Current as of the pick, which may
      // have outlived the unlock.
      const now = catalog.find(context)?.access;
      if (!picked || (now && picked.id === currentMode(now))) return;
      await operations.run(
        {
          action: "setMode",
          context,
          mode: picked.id === NONE ? null : (picked.id as Mode),
        },
        { icon: Shield },
      );
    },
  });

  commands.register({
    id: SET_CONTEXT_ENVIRONMENT,
    title: "Set Environment Type…",
    category: "Space",
    icon: Tag,
    enablement: "context.mode",
    run: async (args) => {
      if (isSetArgs<Environment>(args)) {
        await operations.run(
          {
            action: "setEnvironment",
            context: args.context,
            environment: args.value,
          },
          { icon: Tag },
        );
        return;
      }
      const context = contextOf(args);
      const access = context && catalog.find(context)?.access;
      if (!context || !access) return;
      const items: QuickPickItem[] = [
        ...ENVIRONMENTS.map((environment) => ({
          id: environment,
          label: environmentLabel(environment),
          ...(environment === access.environment && {
            description: "Current",
          }),
        })),
        {
          id: NONE,
          label: "None",
          description: access.environment === null ? "Current" : "No type",
        },
      ];
      const picked = await quickAccess.pick(`Type of ${context}`, items);
      if (
        !picked ||
        picked.id === (catalog.find(context)?.access.environment ?? NONE)
      ) {
        return;
      }
      await operations.run(
        {
          action: "setEnvironment",
          context,
          environment: picked.id === NONE ? null : (picked.id as Environment),
        },
        { icon: Tag },
      );
    },
  });

  commands.register({
    id: UNLOCK_CONTEXT,
    title: "Unlock Context for 15 Minutes",
    category: "Space",
    icon: LockOpen,
    enablement: "context.readOnly",
    run: async (args) => {
      const context = contextOf(args);
      if (context) await operations.unlock(context);
    },
  });

  commands.register({
    id: RELOCK_CONTEXT,
    title: "Lock Context Now",
    category: "Space",
    icon: Lock,
    enablement: "context.unlocked",
    run: async (args) => {
      const context = contextOf(args);
      if (context) await backend.invoke("context_relock", context);
    },
  });

  commands.register({
    id: START_OVER_PROTECTION,
    title: "Start Over…",
    category: "Space",
    icon: RotateCcw,
    run: async () => {
      await operations.run({ action: "startOver" }, { icon: RotateCcw });
    },
  });
  menus.append("commandPalette", {
    command: START_OVER_PROTECTION,
    when: "false",
  });

  menus.append("space/context", {
    command: SET_CONTEXT_ENVIRONMENT,
    group: "1_space",
  });
  menus.append("space/context", {
    command: SET_CONTEXT_MODE,
    group: "1_space",
  });
}
