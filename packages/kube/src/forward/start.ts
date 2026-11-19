import type {
  Forward,
  ForwardPort,
  ForwardPorts,
  ForwardTarget,
} from "@twigo/protocol";
import type { QuickPickItem, Workbench } from "@twigo/workbench";
import { pfUri } from "../uri";
import { tellBind, tellFailure, unlessRefused } from "./busy";
import type { Forwards } from "./service";
import { stateOf } from "./words";

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
 * the core for the target's ports, asks which of them whatever their number,
 * and starts that one, or goes to the forward it has already, never a second.
 */
export function startForward(
  workbench: Workbench,
  forwards: Forwards,
): (target: ForwardTarget) => Promise<void> {
  const { backend, editors, quickAccess } = workbench;
  const told = tellFailure(workbench, forwards);

  const reveal = (target: ForwardTarget, id: Forward["id"]) => {
    editors.open(pfUri({ space: target.space, id }));
  };

  return async (target: ForwardTarget): Promise<void> => {
    const ports = await backend.invoke("forward_ports", target);
    const picked = await quickAccess.pick(
      `Port of ${ports.kind} ${target.name} to forward`,
      pickItems(ports, forwards),
    );
    const chosen = ports.ports.find(({ port }) => String(port) === picked?.id);
    if (!chosen) return;
    if (chosen.forward !== null) {
      reveal(target, chosen.forward);
      return;
    }
    const port = chosen.port;
    const again = (local: number | null) =>
      backend.invoke("forward_start", { target, port, local });
    const started = await unlessRefused(workbench, named(target, chosen), () =>
      again(null),
    );
    if (!started) return;
    tellBind(
      workbench,
      target.space,
      started,
      named(target, chosen),
      again,
      (forward) => {
        told(forward);
        reveal(target, forward.id);
      },
    );
  };
}
