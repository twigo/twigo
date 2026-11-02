import type { Backend, KeyboardLayout } from "@twigo/protocol";
import { toIpcError } from "@twigo/protocol";
import { notify } from "@twigo/ui";
import { Menus } from "./commands/menus";
import { Commands } from "./commands/registry";
import { ContextKeys } from "./contextkey/service";
import { Editors } from "./editors/registry";
import { ShellEnvironmentStatus } from "./environment";
import type { Platform } from "./keybindings/chord";
import { Credentials } from "./credentials";
import { Keybindings } from "./keybindings/service";
import { PartSizes } from "./parts/sizes";
import { QuickAccess } from "./quickaccess/registry";
import { Catalog } from "./spaces/catalog";
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
  readonly editors = new Editors(this.keys);
  readonly quickAccess = new QuickAccess(this.keys);
  readonly keybindings: Keybindings;
  readonly catalog: Catalog;
  readonly spaces: Spaces;
  readonly sizes: PartSizes;
  readonly shellEnvironment: ShellEnvironmentStatus;
  readonly credentials: Credentials;

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
    this.spaces = new Spaces(
      backend,
      state,
      this.catalog,
      this.keys,
      (error) => {
        this.report(error);
      },
    );
    this.sizes = new PartSizes(state);
    this.shellEnvironment = new ShellEnvironmentStatus(backend, this.keys);
    this.credentials = new Credentials(backend, this.spaces, (error) => {
      this.report(error);
    });
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
