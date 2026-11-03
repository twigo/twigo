import type { ActionGroups } from "@twigo/ui";
import type { Lookup } from "../contextkey/when";
import type { Keybindings } from "../keybindings/service";
import type { MenuId, Menus } from "./menus";
import type { Commands } from "./registry";

/**
 * A menu's commands as `ui` actions (ARCHITECTURE 5.1): titles, icons and
 * keys from the registries, disabled where enablement fails, each run
 * against `lookup`. One model for context menus, dropdowns, inline buttons
 * and the selection bar.
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
        return [
          {
            id: item.command,
            label: command.title,
            ...(command.icon && { icon: command.icon }),
            ...(binding && { keys: keybindings.label(binding.presses) }),
            disabled: !commands.enabled(item.command, lookup),
            run: () => {
              void commands.execute(item.command, lookup, args);
            },
          },
        ];
      }),
    )
    .filter((group) => group.length > 0);
}
