import type {
  Forward,
  ForwardPort,
  ForwardPorts,
  ForwardTarget,
} from "@twigo/protocol";
import { notify } from "@twigo/ui";
import type { QuickPickItem, Workbench } from "@twigo/workbench";
import { pfUri } from "../uri";
import { showForwards } from "./actions";
import { tellBind, tellFailure } from "./busy";
import type { Forwards } from "./service";
import { variant } from "./variants";
import { addressOf, stateOf } from "./words";

/** The port as a person names the forward: `web:http`. */
function named(target: ForwardTarget, { port, name }: ForwardPort): string {
  return `${target.name}:${name ?? String(port)}`;
}

/** A port's line in the pick: `http 80 → localhost:8080`, the default first. */
function pickItems(ports: ForwardPorts, forwards: Forwards): QuickPickItem[] {
  const first = ports.ports.filter(({ port }) => port === ports.default);
  const rest = ports.ports.filter(({ port }) => port !== ports.default);
  return [...first, ...rest].map((port) => {
    const shown =
      port.forward === null ? undefined : forwards.get(port.forward);
    const notes = [
      port.port === ports.default ? "default" : undefined,
      port.container ?? undefined,
    ].filter((note) => note !== undefined);
    return {
      id: String(port.port),
      label: `${port.name === null ? "" : `${port.name} `}${String(port.port)} → localhost:${String(port.local)}`,
      ...(notes.length > 0 && { description: notes.join(" · ") }),
      ...(port.forward !== null && {
        state: shown
          ? stateOf(shown)
          : { label: "Forwarded", tone: "idle" as const },
      }),
    };
  });
}

/**
 * What `f` does on a pod, a Service or a workload (ARCHITECTURE 4.4): asks
 * the core for the target's ports, and starts one of them, or goes to the
 * forward that port has already, never a second.
 */
export function startForward(
  workbench: Workbench,
  forwards: Forwards,
): (target: ForwardTarget, options: { pick: boolean }) => Promise<void> {
  const { backend, editors, quickAccess } = workbench;
  const told = tellFailure(forwards);

  const reveal = (target: ForwardTarget, id: Forward["id"]) => {
    if (variant("open") === "list") {
      forwards.select(target.space, id);
      showForwards(workbench);
    } else {
      editors.open(pfUri({ space: target.space, id }));
    }
  };

  const begin = async (
    target: ForwardTarget,
    { pick }: { pick: boolean },
  ): Promise<void> => {
    const ports = await backend.invoke("forward_ports", target);
    const asks = pick || variant("start") === "pick";
    let chosen: ForwardPort | undefined;
    if (asks && (pick || ports.ports.length > 1)) {
      const picked = await quickAccess.pick(
        `Port of ${ports.kind} ${target.name} to forward`,
        pickItems(ports, forwards),
      );
      chosen = ports.ports.find(({ port }) => String(port) === picked?.id);
    } else {
      chosen = ports.ports.find(({ port }) => port === ports.default);
    }
    if (!chosen) return;
    if (chosen.forward !== null) {
      reveal(target, chosen.forward);
      return;
    }
    const port = chosen.port;
    const again = (local: number | null) =>
      backend.invoke("forward_start", { target, port, local });
    const started = await again(null);
    await tellBind(
      workbench,
      started,
      named(target, chosen),
      (local) => again(local),
      (forward) => {
        told(forward);
        reveal(target, forward.id);
        if (!asks) {
          notify.success(
            `Forwarding ${addressOf(forward)} → ${named(target, chosen)}`,
            {
              key: `forward-started:${String(forward.id)}`,
              ...(ports.ports.length > 1 && {
                action: {
                  label: "Change…",
                  run: () => {
                    void begin(target, { pick: true }).catch(
                      (error: unknown) => {
                        workbench.report(error);
                      },
                    );
                  },
                },
              }),
            },
          );
        }
      },
    );
  };
  return begin;
}
