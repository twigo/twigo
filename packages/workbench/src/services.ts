import type { Backend, KeyboardLayout } from "@twigo/protocol";
import { toIpcError } from "@twigo/protocol";
import { notify } from "@twigo/ui";
import { Menus } from "./commands/menus";
import { Commands } from "./commands/registry";
import { ContextKeys } from "./contextkey/service";
import { Editors } from "./editors/registry";
import type { Platform } from "./keybindings/chord";
import { Keybindings } from "./keybindings/service";
import { Spaces } from "./spaces/store";
import { Views } from "./views/registry";
import { registerCore } from "./core";

/**
 * The services of one window. Features, the workbench's own included,
 * contribute through the same registries (ARCHITECTURE 1, 2.3).
 */
export class Workbench {
  readonly keys = new ContextKeys();
  readonly commands = new Commands((command, error) => {
    this.report(error, command);
  });
  readonly menus = new Menus();
  readonly views = new Views();
  readonly editors = new Editors(this.keys);
  readonly keybindings: Keybindings;
  readonly spaces: Spaces;

  constructor(
    readonly backend: Backend,
    readonly platform: Platform,
    layout: KeyboardLayout,
  ) {
    this.keys.set("platform", platform);
    this.keybindings = new Keybindings(
      this.commands,
      this.keys,
      layout,
      platform,
    );
    this.spaces = new Spaces(backend, this.keys, (error) => {
      this.report(error);
    });
  }

  /** Shows a failure the user did not ask to see but must know about. */
  report(error: unknown, command?: string): void {
    const { message } = toIpcError(error);
    const text = command ? `${command}: ${message}` : message;
    notify.error(text, { key: text });
  }
}

/**
 * A workbench on the backend's keyboard layout, following its changes, with
 * the spaces loaded.
 */
export async function createWorkbench(
  backend: Backend,
  platform: Platform,
): Promise<Workbench> {
  // A layout change can only arrive as a later event, once the workbench exists.
  const target: { workbench?: Workbench } = {};
  const layout = await backend.subscribe(
    "keyboard_layout_watch",
    null,
    (next) => {
      target.workbench?.keybindings.setLayout(next);
    },
  );
  const workbench = new Workbench(backend, platform, layout);
  target.workbench = workbench;
  registerCore(workbench);
  await workbench.spaces.load();
  return workbench;
}
