import { ArrowLeftRight } from "lucide-react";
import type { Workbench } from "@twigo/workbench";
import { PF_SCHEME, parsePfUri } from "../uri";
import { registerForwardActions } from "./actions";
import { ForwardActions } from "./ForwardActions";
import { ForwardEditor } from "./ForwardEditor";
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
  const { editors } = workbench;
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
}
