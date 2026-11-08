import type { Backend, KeyboardLayout } from "@twigo/protocol";
import { toIpcError } from "@twigo/protocol";
import { notify, type ActionGroups } from "@twigo/ui";
import { menuActions } from "./commands/actions";
import { Menus, type MenuId } from "./commands/menus";
import { Commands } from "./commands/registry";
import { ContextKeys } from "./contextkey/service";
import { RecentEditors } from "./editors/recent";
import { Editors } from "./editors/registry";
import { ShellEnvironmentStatus } from "./environment";
import type { Platform } from "./keybindings/chord";
import { Credentials } from "./credentials";
import type { Lookup } from "./contextkey/when";
import { Keybindings } from "./keybindings/service";
import { Lists } from "./lists/service";
import { CANCEL_COUNTDOWN, Operations, UNDO } from "./operations/service";
import { PartSizes } from "./parts/sizes";
import { QuickAccess } from "./quickaccess/registry";
import { Catalog } from "./spaces/catalog";
import { ContextColors } from "./spaces/colors";
import { SpaceStatus } from "./spaces/status";
import { Spaces } from "./spaces/store";
import { StateStore } from "./state/store";
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
  readonly editors = new Editors(this.keys, (area) => {
    const space = this.spaces.active;
    if (!space) return;
    // A maximized panel covers the editor area, as VS Code's does until an
    // editor opens there.
    this.spaces.setPart(
      space.id,
      "panel",
      area === "panel" ? { visible: true } : { maximized: false },
    );
  });
  readonly quickAccess = new QuickAccess(this.keys);
  readonly lists = new Lists();
  readonly spaceStatus = new SpaceStatus();
  readonly keybindings: Keybindings;
  readonly catalog: Catalog;
  readonly colors: ContextColors;
  readonly spaces: Spaces;
  readonly recent: RecentEditors;
  readonly sizes: PartSizes;
  readonly shellEnvironment: ShellEnvironmentStatus;
  readonly credentials: Credentials;
  readonly operations: Operations;

  constructor(
    readonly backend: Backend,
    readonly platform: Platform,
    layout: KeyboardLayout,
    readonly state: StateStore,
  ) {
    this.keys.set("platform", platform);
    this.keybindings = new Keybindings(
      this.commands,
      this.keys,
      layout,
      platform,
    );
    this.catalog = new Catalog(backend);
    this.colors = new ContextColors(this.catalog, state);
    this.spaces = new Spaces(
      backend,
      state,
      this.catalog,
      this.keys,
      (error) => {
        this.report(error);
      },
    );
    this.recent = new RecentEditors(this.editors, this.spaces);
    this.sizes = new PartSizes(state);
    this.shellEnvironment = new ShellEnvironmentStatus(backend, this.keys);
    this.credentials = new Credentials(backend, this.spaces, (error) => {
      this.report(error);
    });
    this.operations = new Operations(
      backend,
      this.keys,
      () => {
        const binding = this.keybindings.primary(CANCEL_COUNTDOWN);
        return binding && this.keybindings.label(binding.presses);
      },
      () => {
        const binding = this.keybindings.primary(UNDO);
        return binding && this.keybindings.label(binding.presses);
      },
      (error) => {
        this.report(error);
      },
    );
  }

  /** A menu's commands as actions to draw, run against `lookup` with `args`, such as the space a tile's menu is about. */
  actions(menu: MenuId, lookup: Lookup, args?: unknown): ActionGroups {
    return menuActions(this, menu, lookup, args);
  }

  /** Opens a sign-in link in the person's browser; Rust checks it first. */
  openUrl(url: string): void {
    this.backend.invoke("url_open", url).catch((error: unknown) => {
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
 * A workbench on the backend's keyboard layout and stored state, following
 * their changes, with the spaces loaded. The catalog comes when its sources
 * have been read, which waits for the login shell's environment.
 */
export async function createWorkbench(
  backend: Backend,
  platform: Platform,
): Promise<Workbench> {
  // Tauri sends channel messages apart from the command's response, so a
  // change may arrive first; the watch reads the layout as it subscribes, so
  // such a change is the newer layout.
  const target: { workbench?: Workbench; early?: KeyboardLayout } = {};
  const layout = await backend.subscribe(
    "keyboard_layout_watch",
    null,
    (next) => {
      if (target.workbench) target.workbench.keybindings.setLayout(next);
      else target.early = next;
    },
  );
  const state = await StateStore.load(backend, (error) => {
    target.workbench?.report(error);
  });
  const workbench = new Workbench(
    backend,
    platform,
    target.early ?? layout,
    state,
  );
  target.workbench = workbench;
  registerCore(workbench);
  // Nothing waits for it: the status bar shows the environment when it comes.
  workbench.shellEnvironment.watch().catch((error: unknown) => {
    workbench.report(error);
  });
  workbench.catalog.watch().catch((error: unknown) => {
    workbench.report(error);
  });
  await workbench.spaces.load();
  workbench.credentials.start().catch((error: unknown) => {
    workbench.report(error);
  });
  return workbench;
}
