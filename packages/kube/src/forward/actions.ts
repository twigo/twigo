import {
  ArrowLeftRight,
  Copy,
  ExternalLink,
  PanelRight,
  Pencil,
  Play,
  Square,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import * as v from "valibot";
import type { Forward } from "@twigo/protocol";
import type { MenuId, Workbench } from "@twigo/workbench";
import { pfUri } from "../uri";
import { tellBind, tellFailure, unlessRefused, validPort } from "./busy";
import type { Forwards } from "./service";
import { addressOf, listensOn, targetWords, webUrl } from "./words";

const ARGUMENT = v.object({ id: v.number() });

/** The Port forwards view: the container in the side bar, and its one view. */
export const FORWARDS_CONTAINER = "kube.forwards";
export const FORWARDS_VIEW = "kube.forwards.list";

/** Shows the side bar's Port forwards container in the space. */
export function showForwards(workbench: Workbench): void {
  const { spaces } = workbench;
  const space = spaces.active;
  if (space) {
    spaces.setPart(space.id, "sidebar", {
      visible: true,
      container: FORWARDS_CONTAINER,
    });
  }
}

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

  /** The forward its caller names, else the one selected in the Port forwards list, whose keys name no one. */
  const forwardOf = (args: unknown): Forward | undefined => {
    const parsed = v.safeParse(ARGUMENT, args);
    if (parsed.success) return forwards.get(parsed.output.id);
    const space = workbench.spaces.active?.id;
    const id = space === undefined ? undefined : forwards.selected(space);
    return id === undefined ? undefined : forwards.get(id);
  };

  const resume = async (forward: Forward, local: number | null) => {
    const again = (port: number) =>
      backend.invoke("forward_resume", { id: forward.id, local: port });
    const started = await unlessRefused(workbench, targetWords(forward), () =>
      backend.invoke("forward_resume", { id: forward.id, local }),
    );
    if (started) {
      const stays = listensOn(forward).length > 0 ? forward.local : undefined;
      tellBind(workbench, started, targetWords(forward), again, told, stays);
    }
  };

  const actions: readonly {
    id: string;
    title: string;
    icon: LucideIcon;
    /** What the forward must be, as when-expressions of `forwardKeys` say. */
    when: string;
    /** The menus that place it, each with the group it stands in. */
    menus: readonly (readonly [MenuId, string])[];
    run: (forward: Forward) => void | Promise<void>;
  }[] = [
    {
      id: "k8s.forward.openTab",
      title: "Open",
      icon: PanelRight,
      when: "forward",
      menus: [["view/item", "1_open"]],
      run: ({ id, target }) => {
        editors.open(pfUri({ space: target.space, id }));
      },
    },
    {
      id: "k8s.forward.openInBrowser",
      title: "Open in Browser",
      icon: ExternalLink,
      when: "forward.web",
      menus: [
        ["editor/title", "navigation"],
        ["view/item", "2_use"],
      ],
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
      menus: [
        ["editor/title", "navigation"],
        ["view/item", "2_use"],
      ],
      run: async (forward) => {
        await navigator.clipboard.writeText(addressOf(forward));
      },
    },
    {
      id: "k8s.forward.stop",
      title: "Stop",
      icon: Square,
      when: "forward.running",
      menus: [
        ["editor/title", "navigation"],
        ["view/item", "3_state"],
      ],
      run: async ({ id }) => {
        await backend.invoke("forward_stop", id);
      },
    },
    {
      id: "k8s.forward.start",
      title: "Start",
      icon: Play,
      when: "forward.startable",
      menus: [
        ["editor/title", "navigation"],
        ["view/item", "3_state"],
      ],
      run: (forward) => resume(forward, null),
    },
    {
      id: "k8s.forward.changeLocal",
      title: "Change Local Port…",
      icon: Pencil,
      when: "forward.movable",
      menus: [
        ["editor/title", "navigation"],
        ["view/item", "3_state"],
      ],
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
      menus: [
        ["editor/title", "navigation"],
        ["view/item", "9_remove"],
      ],
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
        const forward = forwardOf(args);
        if (forward) await run(forward);
      },
    });
    // It acts on the forward its caller names, so the palette has nothing to give it.
    menus.append("commandPalette", { command: id, when: "false" });
    for (const [menu, group] of placed) {
      // An item that needs only a forward shows disabled while none is
      // selected, so the first right click on a row has a menu to open, as
      // the resource lists' has.
      const shown = menu === "view/item" && when === "forward" ? {} : { when };
      menus.append(menu, { command: id, group, order, ...shown });
    }
  });

  commands.register({
    id: "k8s.forward.stopAll",
    title: "Stop All Port Forwards",
    category: "Port Forward",
    icon: Square,
    enablement: "forwards.running > 0",
    run: async (_args, lookup) => {
      const space = workbench.spaces.active?.id;
      const running = space === undefined ? [] : forwards.ofSpace(space);
      // The view's title button goes once none runs and takes the focus with it; run from anywhere else the focus stays.
      if (space !== undefined && lookup("view") === FORWARDS_VIEW)
        forwards.focus(space);
      await Promise.all(
        running
          .filter(({ state }) => state.state !== "stopped")
          .map(({ id }) => backend.invoke("forward_stop", id)),
      );
    },
  });
  menus.append("view/title", {
    command: "k8s.forward.stopAll",
    group: "navigation",
    when: `view == ${FORWARDS_VIEW}`,
  });

  commands.register({
    id: "k8s.forwards.show",
    title: "Show Port Forwards",
    category: "Port Forward",
    icon: ArrowLeftRight,
    run: () => {
      showForwards(workbench);
    },
  });
}
