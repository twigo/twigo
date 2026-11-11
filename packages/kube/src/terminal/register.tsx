import { RotateCcw, Terminal } from "lucide-react";
import * as v from "valibot";
import type { Workbench } from "@twigo/workbench";
import {
  parseTerminalUri,
  TERMINAL_SCHEME,
  terminalUri,
  type TerminalInput,
} from "../uri";
import { watchClose } from "../xterm/closed";
import { terminalOptions } from "../xterm/options";
import { registerPicks } from "../xterm/picks";
import { KubeconfigOffers } from "./offers";
import { presentOffers } from "./presentOffers";
import { RESTART_TERMINAL, TerminalEditor } from "./TerminalEditor";
import { TerminalActions } from "./TerminalActions";
import { started, TerminalTabs } from "./tabs";
import { terminalTitle } from "./words";

export function createTerminalTabs(workbench: Workbench): TerminalTabs {
  return new TerminalTabs(terminalOptions(workbench));
}

const NEW_TERMINAL = "k8s.terminal.new";
const TOGGLE_TERMINAL = "k8s.terminal.toggle";

const URI_ARGUMENT = v.object({ uri: v.string() });

/**
 * Terminals on this machine in the panel (ARCHITECTURE 4.6): the
 * `terminal://` editor of `tabs`, each started by `terminal_create` with the
 * space's context.
 */
export function registerTerminals(
  workbench: Workbench,
  tabs: TerminalTabs,
): void {
  const { backend, commands, editors, keybindings, menus, spaces } = workbench;
  editors.onClose((uri) => {
    tabs.closed(uri);
  });
  const offers = new KubeconfigOffers(backend, (error) => {
    workbench.report(error);
  });
  presentOffers(offers);
  offers.watch().catch((error: unknown) => {
    workbench.report(error);
  });
  editors.register({
    id: "kube.terminal",
    scheme: TERMINAL_SCHEME,
    area: "panel",
    space: (uri) => parseTerminalUri(uri.href)?.space,
    title: (uri) => {
      const input = parseTerminalUri(uri.href);
      return input ? terminalTitle(input) : uri.href;
    },
    icon: ({ className }) => <Terminal className={className} />,
    component: ({ uri }) => (
      <TerminalEditor uri={uri} tabs={tabs} offers={offers} />
    ),
    actions: ({ uri }) => (
      <TerminalActions uri={uri} tabs={tabs} offers={offers} />
    ),
    focus: (uri) => {
      tabs.get(uri)?.focus();
    },
  });

  /** Creates the terminal of `input`'s space, and opens its tab at `input`'s URI once the core answers. */
  const start = async (input: TerminalInput): Promise<void> => {
    const [context] =
      spaces.list.find((space) => space.id === input.space)?.contexts ?? [];
    if (context === undefined) return;
    const uri = terminalUri(input);
    const watch = watchClose(editors, uri);
    let created;
    try {
      created = await backend.invoke("terminal_create", {
        context,
        label: terminalTitle(input),
      });
    } catch (error) {
      workbench.report(error);
      return;
    } finally {
      watch.stop();
    }
    if (watch.closed) {
      backend.invoke("shell_close", created.id).catch((error: unknown) => {
        workbench.report(error);
      });
      return;
    }
    tabs.start(uri, input, started(created));
    tabs.touch(uri);
    editors.open(uri);
  };
  editors.changes.subscribe(() => {
    const uri = editors.activeIn("panel");
    if (uri !== undefined && tabs.has(uri)) tabs.touch(uri);
  });

  /** The URIs whose terminal has not been created yet, which another press must not pick too. */
  const planning = new Set<string>();

  /** The first number of a space's terminals that no tab has. */
  const free = (space: string): TerminalInput => {
    for (let n = 1; ; n++) {
      const candidate = { space, n };
      const uri = terminalUri(candidate);
      if (
        !tabs.has(uri) &&
        editors.title(uri) === undefined &&
        !planning.has(uri)
      ) {
        return candidate;
      }
    }
  };

  const open = async (): Promise<void> => {
    const space = spaces.active;
    if (!space) return;
    const input = free(space.id);
    const uri = terminalUri(input);
    planning.add(uri);
    try {
      await start(input);
    } finally {
      planning.delete(uri);
    }
  };

  commands.register({
    id: NEW_TERMINAL,
    title: "New Terminal",
    category: "Terminal",
    icon: Terminal,
    enablement: "space.count > 0",
    run: open,
  });

  commands.register({
    id: TOGGLE_TERMINAL,
    title: "Toggle Terminal",
    category: "Terminal",
    icon: Terminal,
    enablement: "space.count > 0",
    run: async (_args, lookup) => {
      const space = spaces.active;
      if (!space) return;
      if (
        spaces.state(space.id).parts.panel.visible &&
        lookup("terminalFocus")
      ) {
        spaces.setPart(space.id, "panel", { visible: false });
        return;
      }
      const last = tabs.last(space.id);
      if (last === undefined) await open();
      else editors.open(last);
    },
  });
  keybindings.register("core", [
    { key: "ctrl+shift+`", command: NEW_TERMINAL },
    { key: "ctrl+`", command: TOGGLE_TERMINAL },
  ]);

  commands.register({
    id: RESTART_TERMINAL,
    title: "Restart Terminal",
    category: "Terminal",
    icon: RotateCcw,
    enablement: "terminalRestartable",
    run: async (args) => {
      const parsed = v.safeParse(URI_ARGUMENT, args);
      const uri = parsed.success
        ? parsed.output.uri
        : editors.activeIn("panel");
      const input = uri === undefined ? undefined : parseTerminalUri(uri);
      if (input) await start(input);
    },
  });
  menus.append("editor/title", {
    command: RESTART_TERMINAL,
    group: "navigation",
    order: 2,
    when: "terminalRestartable",
  });

  registerPicks(workbench, tabs, {
    noun: "Terminal",
    prefix: "k8s.terminal",
    key: "terminalOpen",
    icon: Terminal,
    row: (tab) => ({ label: terminalTitle(tab.input) }),
  });
}
