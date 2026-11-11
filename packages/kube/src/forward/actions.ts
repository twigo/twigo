import { Copy, ExternalLink, Pencil, Play, Square, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import * as v from "valibot";
import type { Forward } from "@twigo/protocol";
import type { MenuId, Workbench } from "@twigo/workbench";
import { pfUri } from "../uri";
import { tellBind, tellFailure, validPort } from "./busy";
import type { Forwards } from "./service";
import { addressOf, targetWords, webUrl } from "./words";

const ARGUMENT = v.object({ id: v.number() });

/**
 * What a person does to a forward, as commands the tab's title and the
 * list's rows place (ARCHITECTURE 4.3, 4.6). Each acts on the forward its
 * caller names by id.
 */
export function registerForwardActions(
  workbench: Workbench,
  forwards: Forwards,
): void {
  const { backend, commands, editors, menus, quickAccess } = workbench;
  const told = tellFailure(forwards);

  const resume = async (forward: Forward, local: number | null) => {
    const again = (port: number) =>
      backend.invoke("forward_resume", { id: forward.id, local: port });
    const started = await backend.invoke("forward_resume", {
      id: forward.id,
      local,
    });
    await tellBind(workbench, started, targetWords(forward), again, told);
  };

  const actions: readonly {
    id: string;
    title: string;
    icon: LucideIcon;
    /** What the forward must be, as when-expressions of `forwardKeys` say. */
    when: string;
    menus: readonly MenuId[];
    run: (forward: Forward) => void | Promise<void>;
  }[] = [
    {
      id: "k8s.forward.openInBrowser",
      title: "Open in Browser",
      icon: ExternalLink,
      when: "forward.web",
      menus: ["editor/title"],
      run: (forward) => {
        const url = webUrl(forward);
        if (url) workbench.openUrl(url);
      },
    },
    {
      id: "k8s.forward.copyAddress",
      title: "Copy Address",
      icon: Copy,
      when: "forward",
      menus: ["editor/title"],
      run: async (forward) => {
        await navigator.clipboard.writeText(addressOf(forward));
      },
    },
    {
      id: "k8s.forward.stop",
      title: "Stop",
      icon: Square,
      when: "forward.running",
      menus: ["editor/title"],
      run: async ({ id }) => {
        await backend.invoke("forward_stop", id);
      },
    },
    {
      id: "k8s.forward.start",
      title: "Start",
      icon: Play,
      when: "forward.startable",
      menus: ["editor/title"],
      run: (forward) => resume(forward, null),
    },
    {
      id: "k8s.forward.changeLocal",
      title: "Change Local Port…",
      icon: Pencil,
      when: "forward",
      menus: ["editor/title"],
      run: async (forward) => {
        const typed = await quickAccess.input({
          placeholder: "Local port",
          prompt: `Forward ${targetWords(forward)} on localhost port`,
          acceptLabel: "Change",
          value: String(forward.local),
          validate: validPort,
        });
        if (typed !== undefined) await resume(forward, Number(typed.trim()));
      },
    },
    {
      id: "k8s.forward.remove",
      title: "Remove",
      icon: Trash2,
      when: "forward",
      menus: ["editor/title"],
      run: async ({ id, target }) => {
        await backend.invoke("forward_remove", id);
        editors.close(pfUri({ space: target.space, id }));
      },
    },
  ];

  actions.forEach(({ id, title, icon, when, menus: placed, run }, order) => {
    commands.register({
      id,
      title,
      category: "Port Forward",
      icon,
      enablement: when,
      run: async (args) => {
        const parsed = v.safeParse(ARGUMENT, args);
        const forward = parsed.success
          ? forwards.get(parsed.output.id)
          : undefined;
        if (forward) await run(forward);
      },
    });
    // It acts on the forward its caller names, so the palette has nothing to give it.
    menus.append("commandPalette", { command: id, when: "false" });
    for (const menu of placed) {
      menus.append(menu, { command: id, group: "navigation", order, when });
    }
  });
}
