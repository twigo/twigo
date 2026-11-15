import type { ActionGroups } from "@twigo/ui";
import type { Lookup } from "../contextkey/when";
import type { Keybindings } from "../keybindings/service";
import { modeLock } from "../spaces/modes";
import type { MenuId, Menus } from "./menus";
import type { Commands } from "./registry";

/**
 * A menu's commands as `ui` actions (ARCHITECTURE 5.1): titles, icons and
 * keys from the registries, disabled where enablement fails with the reason
 * a requirement gives, locked where the context's mode will refuse what
 * they send, pinned where their item is, each run against `lookup`. One
 * model for context menus, dropdowns, inline buttons and the bars.
 */
export function menuActions(
  {
    menus,
    commands,
    keybindings,
  }: {
    menus: Menus;
    commands: Commands;
    keybindings: Keybindings;
  },
  menu: MenuId,
  lookup: Lookup,
  args?: unknown,
): ActionGroups {
  return menus
    .groups(menu, lookup)
    .map((group) =>
      group.flatMap((item) => {
        const command = commands.get(item.command);
        if (!command) return [];
        const binding = keybindings.primary(item.command);
        const enabled = commands.enabled(item.command, lookup);
        const lock = enabled && command.sends ? modeLock(lookup) : undefined;
        const reason = enabled ? lock : commands.reason(item.command, lookup);
        return [
          {
            id: item.command,
            label: command.title,
            ...(command.icon && { icon: command.icon }),
            ...(binding && { keys: keybindings.label(binding.presses) }),
            ...(command.danger && { danger: true }),
            ...(item.pinned && { pinned: true }),
            disabled: !enabled,
            ...(reason !== undefined && { reason }),
            ...(lock !== undefined && { locked: true }),
            run: () => {
              void commands.execute(item.command, lookup, args);
            },
          },
        ];
      }),
    )
    .filter((group) => group.length > 0);
}
