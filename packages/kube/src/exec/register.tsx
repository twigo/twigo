import { RotateCcw, SquareTerminal } from "lucide-react";
import * as v from "valibot";
import type { ShellKind, ShellTarget } from "@twigo/protocol";
import type { QuickPickItem, StatusEntry, Workbench } from "@twigo/workbench";
import { useChanges } from "@twigo/workbench";
import { EXEC_SCHEME, execUri, parseExecUri, type ExecInput } from "../uri";
import { ExecActions } from "./ExecActions";
import { ExecEditor } from "./ExecEditor";
import { canShell } from "./kinds";
import { ExecTabs } from "./tabs";
import { ending, execTitle, stateOf } from "./words";

export function createExecTabs(workbench: Workbench): ExecTabs {
  return new ExecTabs({
    backend: workbench.backend,
    platform: workbench.platform,
    report: (error) => {
      workbench.report(error);
    },
    openUrl: (url) => {
      workbench.openUrl(url);
    },
    binds: (event) => workbench.keybindings.handles(event),
  });
}

/** A `k8s.shell.open` request: a pod, and maybe a container and what to start in it. */
const REQUEST = v.object({
  space: v.string(),
  gvr: v.object({
    group: v.string(),
    version: v.string(),
    resource: v.string(),
  }),
  namespace: v.string(),
  name: v.string(),
  container: v.optional(v.string()),
  kind: v.optional(v.picklist(["shell", "attach"])),
});

const URI_ARGUMENT = v.object({ uri: v.string() });

/**
 * Shells and attaches in the panel (ARCHITECTURE 4.6): the `exec://` editor
 * of `tabs`, opened by `s` on a pod, in its details and its context menu,
 * and in an object editor's title through `k8s.shell.open`; a status-bar
 * entry lists the open shells.
 */
export function registerExec(workbench: Workbench, tabs: ExecTabs): void {
  const { backend, commands, editors, keys, menus, operations, quickAccess } =
    workbench;
  editors.onClose((uri) => {
    tabs.closed(uri);
  });
  editors.register({
    id: "kube.exec",
    scheme: EXEC_SCHEME,
    area: "panel",
    space: (uri) => parseExecUri(uri.href)?.space,
    title: (uri) => {
      const input = parseExecUri(uri.href);
      return input ? execTitle(input) : uri.href;
    },
    icon: ({ className }) => <SquareTerminal className={className} />,
    component: ({ uri }) => <ExecEditor uri={uri} tabs={tabs} />,
    actions: ({ uri }) => <ExecActions uri={uri} tabs={tabs} />,
    focus: (uri) => {
      tabs.get(uri)?.focus();
    },
  });

  const targetOf = (input: ExecInput, container: string): ShellTarget => ({
    space: input.space,
    namespace: input.namespace,
    pod: input.pod,
    container,
  });

  /** Plans a shell, and opens its tab at `input`'s URI once the run answers with a session. */
  const start = async (input: ExecInput): Promise<void> => {
    const outcome = await operations.run(
      {
        action: "shell",
        target: targetOf(input, input.container),
        kind: input.attach === true ? "attach" : "shell",
      },
      { icon: SquareTerminal },
    );
    if (outcome.state !== "session") return;
    const uri = execUri(input);
    tabs.start(uri, input, outcome.id);
    editors.open(uri);
  };

  /** The first URI of a container's shells that no tab has. */
  const free = (input: ExecInput): ExecInput => {
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? input : { ...input, n };
      const uri = execUri(candidate);
      if (!tabs.has(uri) && editors.title(uri) === undefined) return candidate;
    }
  };

  /**
   * Asks which container when several run, and opens a shell or an attach in
   * it, in a tab of its own.
   */
  const open = async (
    pod: { space: string; namespace: string; pod: string },
    kind: ShellKind,
    chosen?: { container?: string },
  ): Promise<void> => {
    let found;
    try {
      found = await backend.invoke("shell_containers", pod);
    } catch (error) {
      workbench.report(error);
      return;
    }
    let container = chosen?.container;
    if (container === undefined) {
      const [only] = found.containers;
      if (found.containers.length > 1) {
        const items: QuickPickItem[] = found.containers.map((name) => ({
          id: name,
          label: name,
          ...(name === found.default && { description: "default" }),
        }));
        container = (
          await quickAccess.pick(`Container to open in ${pod.pod}`, items)
        )?.id;
      } else {
        container = only;
      }
    }
    if (container === undefined) return;
    const base: ExecInput = {
      ...pod,
      container,
      ...(kind === "attach" && { attach: true }),
    };
    await start(free(base));
  };

  commands.register({
    id: "k8s.shell.open",
    title: "Shell",
    category: "Shell",
    icon: SquareTerminal,
    run: async (args) => {
      const parsed = v.safeParse(REQUEST, args);
      if (!parsed.success || !canShell(parsed.output.gvr)) return;
      const { space, namespace, name, container, kind } = parsed.output;
      await open({ space, namespace, pod: name }, kind ?? "shell", {
        ...(container !== undefined && { container }),
      });
    },
  });
  // It acts on the object its caller names, so the palette has nothing to give it.
  menus.append("commandPalette", { command: "k8s.shell.open", when: "false" });
  menus.append("editor/title", {
    command: "k8s.shell.open",
    group: "navigation",
    order: 1,
    when: "resource.shell",
  });

  const uriOf = (args: unknown): string | undefined => {
    const parsed = v.safeParse(URI_ARGUMENT, args);
    return parsed.success ? parsed.output.uri : editors.activeIn("panel");
  };
  commands.register({
    id: "k8s.shell.restart",
    title: "Restart Shell",
    category: "Shell",
    icon: RotateCcw,
    enablement: "execEnded",
    run: async (args) => {
      const uri = uriOf(args);
      const input = uri === undefined ? undefined : parseExecUri(uri);
      if (input) await start(input);
    },
  });
  menus.append("editor/title", {
    command: "k8s.shell.restart",
    group: "navigation",
    order: 2,
    when: "execEnded",
  });

  /** The active space's shell tabs, as rows to pick. */
  const rows = (): QuickPickItem[] => {
    const space = workbench.spaces.active?.id;
    return tabs
      .list()
      .filter(([, tab]) => tab.input.space === space)
      .map(([uri, tab]) => {
        const status = tab.getStatus();
        const { label, tone, pulse } = stateOf(status);
        return {
          id: uri,
          label: execTitle(tab.input),
          description: tab.input.namespace,
          icon: ({ className }) => <SquareTerminal className={className} />,
          ...(status.state !== "running" && {
            state: {
              tone,
              label:
                status.state === "ended" ? ending(status.end).label : label,
              ...(pulse && { pulse }),
            },
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
      id: "k8s.shell.show",
      title: "Go to Shell…",
      placeholder: "Go to a shell",
      accept: (uri) => {
        editors.open(uri);
      },
    },
    {
      id: "k8s.shell.close",
      title: "Close Shell…",
      placeholder: "Close a shell",
      accept: (uri) => {
        editors.close(uri);
      },
    },
  ];
  for (const { id, title, placeholder, accept } of picks) {
    commands.register({
      id,
      title,
      category: "Shell",
      enablement: "execOpen",
      run: async () => {
        const picked = await quickAccess.pick(placeholder, rows());
        if (picked) accept(picked.id);
      },
    });
  }
  const listed = () => {
    keys.set("execOpen", tabs.list().length > 0);
  };
  tabs.changes.subscribe(listed);

  workbench.views.registerStatusBarItem({
    id: "kube.shells",
    alignment: "left",
    priority: 170,
    useEntries: () => {
      useChanges(tabs.changes);
      useChanges(workbench.spaces.changes);
      const space = workbench.spaces.active?.id;
      const live = tabs
        .list()
        .filter(([, tab]) => tab.input.space === space && tab.live);
      const entry: StatusEntry = {
        id: "shells",
        text: live.length === 1 ? "1 shell" : `${String(live.length)} shells`,
        icon: SquareTerminal,
        tooltip: "Open shells: go to one",
        run: () => {
          void commands.execute("k8s.shell.show", keys.lookup(null));
        },
      };
      return live.length === 0 ? [] : [entry];
    },
  });
}
