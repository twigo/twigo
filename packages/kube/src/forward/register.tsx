import { ArrowLeftRight } from "lucide-react";
import * as v from "valibot";
import type { Workbench } from "@twigo/workbench";
import { PF_SCHEME, parsePfUri } from "../uri";
import {
  FORWARDS_CONTAINER,
  FORWARDS_VIEW,
  registerForwardActions,
} from "./actions";
import { ForwardActions } from "./ForwardActions";
import { ForwardEditor } from "./ForwardEditor";
import { ForwardsView } from "./ForwardsView";
import { canForward } from "./kinds";
import type { Forwards } from "./service";
import { startForward } from "./start";
import { forwardEntries } from "./statusEntries";
import { forwardTitle } from "./words";

/** A `k8s.forward.open` request: a target, and whether to pick its port whatever the number. */
const REQUEST = v.object({
  space: v.string(),
  gvr: v.object({
    group: v.string(),
    version: v.string(),
    resource: v.string(),
  }),
  namespace: v.string(),
  name: v.string(),
  pick: v.optional(v.boolean()),
});

/**
 * Port-forwards (ARCHITECTURE 4.6): this window follows the core's, which
 * outlive it, and everything that draws or acts on a forward reads the
 * service. A forward is a `pf://` editor in the editor area, with its
 * state and its actions in its title.
 */
export function registerForwards(
  workbench: Workbench,
  forwards: Forwards,
): void {
  const { commands, editors, keybindings, keys, menus, spaces, views } =
    workbench;
  forwards.watch().catch((error: unknown) => {
    workbench.report(error);
  });

  editors.register({
    id: "kube.forward",
    scheme: PF_SCHEME,
    space: (uri) => parsePfUri(uri.href)?.space,
    title: (uri) => {
      const input = parsePfUri(uri.href);
      const forward = input && forwards.find(input);
      return forward ? forwardTitle(forward) : "Port forward";
    },
    icon: ({ className }) => <ArrowLeftRight className={className} />,
    component: ({ uri }) => <ForwardEditor uri={uri} forwards={forwards} />,
    actions: ({ uri }) => <ForwardActions uri={uri} forwards={forwards} />,
  });
  registerForwardActions(workbench, forwards);

  const start = startForward(workbench, forwards);
  commands.register({
    id: "k8s.forward.open",
    title: "Forward",
    category: "Port Forward",
    icon: ArrowLeftRight,
    run: async (args) => {
      const parsed = v.safeParse(REQUEST, args);
      if (!parsed.success || !canForward(parsed.output.gvr)) return;
      const { pick, ...target } = parsed.output;
      await start(target, { pick: pick === true });
    },
  });
  // It acts on the object its caller names, so the palette has nothing to give it.
  menus.append("commandPalette", {
    command: "k8s.forward.open",
    when: "false",
  });
  menus.append("editor/title", {
    command: "k8s.forward.open",
    group: "navigation",
    order: 3,
    when: "resource.forward",
  });

  views.registerContainer({
    id: FORWARDS_CONTAINER,
    title: "Port forwards",
    icon: ArrowLeftRight,
    location: "sidebar",
    order: 1,
  });
  views.registerView({
    id: FORWARDS_VIEW,
    title: "Port forwards",
    container: FORWARDS_CONTAINER,
    component: () => <ForwardsView forwards={forwards} />,
  });
  views.registerStatusBarItem({
    id: "kube.forwards",
    alignment: "left",
    priority: 160,
    useEntries: forwardEntries(workbench, forwards),
  });
  keybindings.register("core", [
    { key: "mod+c", command: "k8s.forward.copyAddress", when: "forwardsFocus" },
    { key: "delete", command: "k8s.forward.remove", when: "forwardsFocus" },
    { key: "backspace", command: "k8s.forward.remove", when: "forwardsFocus" },
  ]);

  const countRunning = () => {
    const space = spaces.active?.id;
    keys.set(
      "forwards.running",
      space === undefined ? 0 : forwards.running(space).length,
    );
  };
  forwards.changes.subscribe(countRunning);
  spaces.changes.subscribe(countRunning);
  countRunning();
}
