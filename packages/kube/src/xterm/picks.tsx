import type { LucideIcon } from "lucide-react";
import type { QuickPickItem, Workbench } from "@twigo/workbench";
import type { Changes } from "@twigo/workbench";
import type { ShellTerminal } from "./terminal";
import { stateOf } from "./words";

/** What the picks of one kind of tab need of its registry. */
interface Pickable<T> {
  readonly changes: Changes;
  list(): readonly (readonly [string, T])[];
}

/**
 * Go to and Close in the palette for the tabs of the active space, with
 * their state beside those that are not running, and the context key
 * `key` that holds while any is open.
 */
export function registerPicks<
  T extends ShellTerminal & { readonly input: { readonly space: string } },
>(
  workbench: Workbench,
  tabs: Pickable<T>,
  options: {
    /** `Shell`: the commands read `Go to Shell…`. */
    readonly noun: string;
    /** `k8s.shell`: the commands are `k8s.shell.show` and `k8s.shell.close`. */
    readonly prefix: string;
    readonly key: string;
    readonly icon: LucideIcon;
    readonly row: (tab: T) => { label: string; description?: string };
  },
): void {
  const { commands, editors, keys, quickAccess, spaces } = workbench;
  const { noun, prefix, key, icon: Icon, row } = options;

  const rows = (): QuickPickItem[] => {
    const space = spaces.active?.id;
    return tabs
      .list()
      .filter(([, tab]) => tab.input.space === space)
      .map(([uri, tab]) => {
        const status = tab.getStatus();
        const { label, tone, pulse } = stateOf(status);
        return {
          id: uri,
          ...row(tab),
          icon: ({ className }) => <Icon className={className} />,
          ...(status.state !== "running" && {
            state: { tone, label, ...(pulse && { pulse }) },
          }),
        };
      });
  };
  const picks: readonly {
    id: string;
    title: string;
    placeholder: string;
    accept: (uri: string) => void;
  }[] = [
    {
      id: `${prefix}.show`,
      title: `Go to ${noun}…`,
      placeholder: `Go to a ${noun.toLowerCase()}`,
      accept: (uri) => {
        editors.open(uri);
      },
    },
    {
      id: `${prefix}.close`,
      title: `Close ${noun}…`,
      placeholder: `Close a ${noun.toLowerCase()}`,
      accept: (uri) => {
        editors.close(uri);
      },
    },
  ];
  for (const { id, title, placeholder, accept } of picks) {
    commands.register({
      id,
      title,
      category: noun,
      enablement: key,
      run: async () => {
        const picked = await quickAccess.pick(placeholder, rows());
        if (picked) accept(picked.id);
      },
    });
  }
  tabs.changes.subscribe(() => {
    keys.set(key, tabs.list().length > 0);
  });
}
