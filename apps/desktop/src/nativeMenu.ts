import {
  Menu,
  Submenu,
  type MenuItemOptions,
  type PredefinedMenuItemOptions,
} from "@tauri-apps/api/menu";
import { nativeMenus, type Workbench } from "@twigo/workbench";

type Entry = MenuItemOptions | PredefinedMenuItemOptions;

const SEPARATOR: PredefinedMenuItemOptions = { item: "Separator" };

/** macOS's own items, which the webview's text fields and the window need. */
const APP: readonly PredefinedMenuItemOptions[] = [
  { item: { About: null } },
  SEPARATOR,
  { item: "Services" },
  SEPARATOR,
  { item: "Hide" },
  { item: "HideOthers" },
  { item: "ShowAll" },
  SEPARATOR,
  { item: "Quit" },
];

const OWN: Readonly<Record<string, readonly PredefinedMenuItemOptions[]>> = {
  Edit: [
    { item: "Undo" },
    { item: "Redo" },
    SEPARATOR,
    { item: "Cut" },
    { item: "Copy" },
    { item: "Paste" },
    { item: "SelectAll" },
  ],
  Window: [{ item: "Minimize" }, { item: "Maximize" }],
};

/**
 * Sets the macOS menu bar from the workbench's menu registry (ARCHITECTURE
 * 5.1) and sets it again whenever a command, menu or keybinding changes.
 */
export function installNativeMenu(workbench: Workbench): void {
  const build = async () => {
    const submenus = await Promise.all([
      Submenu.new({ text: "Twigo", items: [...APP] }),
      ...nativeMenus(workbench).map(({ title, groups }) => {
        const own = OWN[title] ?? [];
        const items: Entry[] = [...own];
        for (const group of groups) {
          if (items.length > 0) items.push(SEPARATOR);
          for (const { command, title: text, accelerator } of group) {
            items.push({
              text,
              ...(accelerator && { accelerator }),
              action: () => {
                void workbench.commands.execute(
                  command,
                  workbench.keys.lookup(document.activeElement),
                );
              },
            });
          }
        }
        return Submenu.new({ text: title, items });
      }),
    ]);
    const menu = await Menu.new({ items: submenus });
    // Each handle is an entry in Tauri's resource table: the menu holds its
    // submenus and the app holds the menu it shows, so dropping our handles
    // leaves the returned previous menu as the old tree's last one, and
    // closing it frees the old items and their action channels.
    await Promise.all(submenus.map((submenu) => submenu.close()));
    const previous = await menu.setAsAppMenu();
    await Promise.all([menu.close(), previous?.close()]);
  };
  // One build at a time: setAsAppMenu is an async command, so two builds in
  // flight could land in either order and leave the older menu up. A change
  // during a build asks for one more build after it.
  let building = false;
  let again = false;
  const drain = async () => {
    while (again) {
      again = false;
      await build().catch((error: unknown) => {
        workbench.report(error);
      });
    }
    building = false;
  };
  const rebuild = () => {
    again = true;
    if (building) return;
    building = true;
    queueMicrotask(() => {
      void drain();
    });
  };
  workbench.commands.changes.subscribe(rebuild);
  workbench.menus.changes.subscribe(rebuild);
  workbench.keybindings.changes.subscribe(rebuild);
  rebuild();
}
