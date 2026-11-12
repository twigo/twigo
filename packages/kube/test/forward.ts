import type { Backend, Forward, ForwardEvent } from "@twigo/protocol";

/** A backend whose forwards come through `patch`, in the first answer of `forwards_watch` and in every event. */
export function patching(
  backend: Backend,
  patch: (forward: Forward) => Forward,
): Backend {
  return {
    invoke: (command, request) => backend.invoke(command, request),
    subscribe: (async (
      command: string,
      request: never,
      onMessage: (event: ForwardEvent) => void,
    ) => {
      if (command !== "forwards_watch") {
        return backend.subscribe(
          command as "forwards_watch",
          request,
          onMessage,
        );
      }
      const first = await backend.subscribe("forwards_watch", null, (event) => {
        onMessage(
          event.event === "changed"
            ? { event: "changed", forward: patch(event.forward) }
            : event,
        );
      });
      return first.map(patch);
    }),
  };
}
