import * as v from "valibot";
import { fuzzyMatch } from "@twigo/ui";
import { onlyColor } from "../parts/spaceBadge";
import type { Workbench } from "../services";
import type { QuickAccessProvider, QuickPickItem } from "./registry";

/**
 * Items whose label matches the filter, best first, with what matched; all
 * of them, in order, for no filter.
 */
export function filtered<T extends QuickPickItem>(
  items: readonly T[],
  filter: string,
): T[] {
  const search = filter.trim();
  if (search === "") return [...items];
  return items
    .flatMap((item) => {
      const match = fuzzyMatch(item.label, search);
      return match
        ? [{ item: { ...item, matches: match.ranges }, score: match.score }]
        : [];
    })
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item);
}

const HISTORY_KEY = "quickaccess/history";
const HISTORY = v.array(v.string());
const HISTORY_SIZE = 20;

/** `>`: every command its `commandPalette` item lets show, recently used first (legacy commandHistory). */
export function commandsProvider(workbench: Workbench): QuickAccessProvider {
  const { commands, menus, keybindings, state } = workbench;
  const history = () => state.get(null, HISTORY_KEY, HISTORY, []);
  return {
    prefix: ">",
    placeholder: "Type the name of a command to run",
    help: "Run a command",
    hint: "Commands",
    acceptLabel: "Run",
    items(filter, { lookup }) {
      const recent = history();
      const rank = (id: string) => {
        const at = recent.indexOf(id);
        return at < 0 ? recent.length : at;
      };
      const items = commands
        .all()
        .filter((command) => menus.shows("commandPalette", command.id, lookup))
        .filter((command) => commands.enabled(command.id, lookup))
        .map((command) => {
          const binding = keybindings.primary(command.id);
          return {
            id: command.id,
            label: `${command.category}: ${command.title}`,
            ...(command.icon && { icon: command.icon }),
            ...(binding && { keybinding: keybindings.label(binding.presses) }),
          };
        })
        .sort(
          (a, b) => rank(a.id) - rank(b.id) || a.label.localeCompare(b.label),
        );
      return filtered(items, filter);
    },
    async accept(item, _filter, { lookup }) {
      const recent = history().filter((id) => id !== item.id);
      state.set(null, HISTORY_KEY, [item.id, ...recent].slice(0, HISTORY_SIZE));
      await commands.execute(item.id, lookup);
    },
  };
}

/** `?`: the prefixes, then every command that has a keybinding. */
export function helpProvider(workbench: Workbench): QuickAccessProvider {
  const { quickAccess, commands, keybindings } = workbench;
  return {
    prefix: "?",
    placeholder: "Pick a prefix, or a command to run by its keys",
    help: "Show this help",
    hint: "Help",
    items(filter) {
      const prefixes = quickAccess
        .providers()
        .filter((provider) => provider.prefix !== "?")
        .map((provider) => ({
          id: `prefix:${provider.prefix}`,
          label: provider.prefix.trim() === "" ? "…" : provider.prefix,
          description: provider.help,
          group: "Prefixes",
        }));
      const bound = commands.all().flatMap((command) => {
        const binding = keybindings.primary(command.id);
        return binding
          ? [
              {
                id: `command:${command.id}`,
                label: `${command.category}: ${command.title}`,
                keybinding: keybindings.label(binding.presses),
                group: "Keybindings",
              },
            ]
          : [];
      });
      return filtered(
        [...prefixes, ...bound.sort((a, b) => a.label.localeCompare(b.label))],
        filter,
      );
    },
    async accept(item, _filter, { lookup }) {
      if (item.id.startsWith("prefix:")) {
        quickAccess.show(item.id.slice("prefix:".length));
        return;
      }
      await commands.execute(item.id.slice("command:".length), lookup);
    },
  };
}

/**
 * `ctx `: switch to a space, or open the space of a context that has none
 * (ARCHITECTURE 4.2). The open spaces come first with their connections and
 * keys, then the other contexts by the kubeconfig file that defines them.
 */
export function spacesProvider(workbench: Workbench): QuickAccessProvider {
  const { spaces, catalog, spaceStatus, keybindings } = workbench;
  return {
    prefix: "ctx ",
    placeholder: "Switch to a space, or open one for a context",
    help: "Switch or open a space",
    acceptLabel: "Switch",
    items(filter) {
      const open = spaces.list.map((space, index): QuickPickItem => {
        const [only, ...more] = space.contexts;
        const context =
          only !== undefined && more.length === 0
            ? catalog.find(only)
            : undefined;
        const server = context && hostOf(context.server);
        const connection = spaceStatus.get(space.id);
        const binding = keybindings.primary(
          `workbench.action.selectSpace${String(index + 1)}`,
        );
        return {
          id: `space:${space.id}`,
          label: space.name,
          tile: { name: space.name, color: onlyColor(space, catalog) },
          ...(context
            ? server && { description: server }
            : { description: space.contexts.join(" + ") }),
          ...(connection && {
            state: {
              tone: connection.tone,
              // As the status bar says it: the version alone while connected.
              label:
                connection.tone === "ok" && connection.version
                  ? connection.version
                  : connection.label,
            },
          }),
          ...(binding && { keybinding: keybindings.label(binding.presses) }),
          group: "Open spaces",
        };
      });
      const own = new Set(
        spaces.list.flatMap((space) =>
          space.contexts.length === 1 ? space.contexts : [],
        ),
      );
      const files = new Map<string, QuickPickItem[]>();
      for (const context of catalog.list ?? []) {
        if (own.has(context.name)) continue;
        const server = hostOf(context.server);
        files.set(context.source, [
          ...(files.get(context.source) ?? []),
          {
            id: `context:${context.name}`,
            label: context.name,
            tile: { name: context.name, color: context.color ?? undefined },
            ...(server && { description: server }),
            group: context.source,
          },
        ]);
      }
      return [open, ...files.values()].flatMap((section) =>
        filtered(section, filter),
      );
    },
    async accept(item) {
      if (item.id.startsWith("space:")) {
        spaces.select(item.id.slice("space:".length));
        return;
      }
      await spaces.open(item.id.slice("context:".length));
    },
  };
}

/** A server's host and port, as the picker shows it; what no URL parser takes shows as it is. */
function hostOf(server: string | null): string | undefined {
  if (server === null) return undefined;
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

/** `@`: the symbols the active editor publishes, such as a YAML outline. */
export function symbolsProvider(workbench: Workbench): QuickAccessProvider {
  const { editors } = workbench;
  return {
    prefix: "@",
    placeholder: "Go to a symbol of the active editor",
    help: "Go to a symbol in the editor",
    acceptLabel: "Go to",
    items(filter) {
      const active = editors.active;
      const symbols = active === undefined ? [] : editors.symbols(active);
      return filtered(
        symbols.map((symbol, index) => ({
          id: String(index),
          label: symbol.label,
          ...(symbol.detail && { description: symbol.detail }),
        })),
        filter,
      );
    },
    accept(item) {
      const active = editors.active;
      if (active === undefined) return;
      editors.symbols(active)[Number(item.id)]?.reveal();
    },
  };
}
