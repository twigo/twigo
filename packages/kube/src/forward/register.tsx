import { ArrowLeftRight } from "lucide-react";
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
import type { Forwards } from "./service";
import { forwardTitle } from "./words";

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
  const { editors, keybindings, keys, spaces, views } = workbench;
  forwards.watch().catch((error: unknown) => {
    workbench.report(error);
  });

  editors.register({
    id: "kube.forward",
    scheme: PF_SCHEME,
    space: (uri) => parsePfUri(uri.href)?.space,
    title: (uri) => {
      const input = parsePfUri(uri.href);
      const forward = input && forwards.get(input.id);
      return forward ? forwardTitle(forward) : "Port forward";
    },
    icon: ({ className }) => <ArrowLeftRight className={className} />,
    component: ({ uri }) => <ForwardEditor uri={uri} forwards={forwards} />,
    actions: ({ uri }) => <ForwardActions uri={uri} forwards={forwards} />,
  });
  registerForwardActions(workbench, forwards);

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
  keybindings.register("core", [
    { key: "mod+c", command: "k8s.forward.copyAddress", when: "forwardsFocus" },
    { key: "delete", command: "k8s.forward.remove", when: "forwardsFocus" },
    { key: "backspace", command: "k8s.forward.remove", when: "forwardsFocus" },
  ]);

  const countRunning = () => {
    const space = spaces.active?.id;
    const running =
      space === undefined
        ? 0
        : forwards
            .ofSpace(space)
            .filter(({ state }) => state.state !== "stopped").length;
    keys.set("forwards.running", running);
  };
  forwards.changes.subscribe(countRunning);
  spaces.changes.subscribe(countRunning);
  countRunning();
}
