import { useEffect, useMemo, type ReactNode } from "react";
import { Hourglass, Info, Unplug } from "lucide-react";
import { CLUSTER_SESSIONS, type Forward } from "@twigo/protocol";
import {
  Banner,
  Callout,
  EmptyState,
  LinkButton,
  PropertyList,
  Skeleton,
  StatusLabel,
  type Property,
} from "@twigo/ui";
import { formatBytes } from "@twigo/utils";
import { useChanges, useWorkbench, type EditorProps } from "@twigo/workbench";
import { objectUri, parsePfUri } from "../uri";
import type { Forwards } from "./service";
import { addressOf, forwardTitle, portWords, stateOf } from "./words";

const PODS = { group: "", version: "v1", resource: "pods" };

/**
 * A `pf://` editor (ARCHITECTURE 4.3): one forward as the core has it, live:
 * its state in words with the reason, what it reaches and where, and how it
 * is used. It keeps nothing, since the service has the forward by id.
 */
export function ForwardEditor({
  uri,
  forwards,
}: EditorProps & { forwards: Forwards }) {
  const { editors } = useWorkbench();
  useChanges(forwards.changes);
  const input = useMemo(() => parsePfUri(uri), [uri]);
  const forward = input && forwards.get(input.id);
  const title = forward && forwardTitle(forward);
  useEffect(() => {
    if (title) editors.setTitle(uri, title);
  }, [editors, uri, title]);

  if (!input) {
    return (
      <EmptyState title="Not a port-forward" className="h-full">
        {uri}
      </EmptyState>
    );
  }
  if (!forward) {
    return forwards.loaded ? (
      <EmptyState
        icon={Unplug}
        title="This port-forward is gone"
        action={{
          label: "Close",
          onClick: () => {
            editors.close(uri);
          },
        }}
        className="h-full"
      >
        <p>It was removed, so there is nothing left to show.</p>
      </EmptyState>
    ) : (
      <div aria-busy className="flex flex-col gap-3 p-4">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-3 w-2/5" />
      </div>
    );
  }
  return <Loaded uri={uri} forward={forward} />;
}

function Loaded({ uri, forward }: { uri: string; forward: Forward }) {
  const { editors } = useWorkbench();
  const shown = stateOf(forward);
  const { target, pod, queued } = forward;
  const open = (name: string, pods: boolean) => {
    editors.pin(uri);
    editors.open(
      objectUri({
        space: target.space,
        gvr: pods ? PODS : target.gvr,
        namespace: target.namespace,
        name,
      }),
      { preview: true },
    );
  };
  const items: Property[] = [
    {
      key: "state",
      label: "State",
      value: (
        <StatusLabel tone={shown.tone} {...(shown.pulse && { pulse: true })}>
          {shown.label}
        </StatusLabel>
      ),
    },
    {
      key: "target",
      label: forward.kind,
      value: (
        <LinkButton
          onClick={() => {
            open(target.name, false);
          }}
        >
          {target.namespace}/{target.name}
        </LinkButton>
      ),
    },
    { key: "port", label: "Port", value: portWords(forward) },
    {
      key: "pod",
      label: "Pod",
      value:
        pod === null ? (
          <Quiet>Not chosen yet</Quiet>
        ) : (
          <>
            <LinkButton
              onClick={() => {
                open(pod, true);
              }}
            >
              {pod}
            </LinkButton>
            {forward.podPort !== null && (
              <Quiet> port {String(forward.podPort)}</Quiet>
            )}
          </>
        ),
    },
    {
      key: "address",
      label: "Local address",
      value: (
        <>
          <code className="font-mono text-xs">{addressOf(forward)}</code>
          <Quiet> on {forward.addresses.join(" and ")}</Quiet>
        </>
      ),
    },
    {
      key: "connections",
      label: "Connections",
      value:
        queued > 0
          ? `${String(forward.connections)}, ${String(queued)} waiting`
          : String(forward.connections),
    },
    { key: "sent", label: "Sent", value: formatBytes(forward.sent) },
    {
      key: "received",
      label: "Received",
      value: formatBytes(forward.received),
    },
    {
      key: "failure",
      label: "Last failure",
      value: forward.failure ?? <Quiet>None</Quiet>,
    },
  ];
  return (
    <div className="flex h-full min-h-0 flex-col bg-editor">
      <Notices forward={forward} />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex max-w-3xl flex-col gap-4 px-3.5 pt-3 pb-4 text-[13px]">
          <h2 className="truncate text-sm font-semibold">
            {forwardTitle(forward)}
          </h2>
          <Problem forward={forward} />
          <PropertyList items={items} />
        </div>
      </div>
    </div>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/** The bars over the tab, for what holds of the forward as a whole. */
function Notices({ forward }: { forward: Forward }) {
  const { state, queued } = forward;
  return (
    <>
      {state.state === "restored" && (
        <Banner tone="info" icon={Info} title="Restored when Twigo started.">
          It listens on {addressOf(forward)}; its cluster is asked at the first
          connection, or when its space connects.
        </Banner>
      )}
      {state.state === "stopped" && (
        <Banner tone="info" icon={Info} title="Stopped.">
          Nothing listens on {addressOf(forward)}; Start brings it back.
        </Banner>
      )}
      {queued > 0 && (
        <Banner
          tone="warn"
          icon={Hourglass}
          title={`Waiting for a place among the context's ${String(CLUSTER_SESSIONS)} sessions.`}
        >
          Close a shell or another connection to free one.
        </Banner>
      )}
    </>
  );
}

/** What went wrong, in the core's words. */
function Problem({ forward }: { forward: Forward }) {
  const { state } = forward;
  if (state.state === "reconnecting") {
    return (
      <Callout tone="warn" title="Reconnecting">
        <p>{state.reason}</p>
      </Callout>
    );
  }
  if (state.state === "failed" && state.error.blocked) {
    const { context, mode } = state.error.blocked;
    return (
      <Callout tone="warn" title={`${context} is ${mode}`}>
        <p className="break-words">{state.error.message}</p>
        <p className="text-muted-foreground">
          It still listens on {addressOf(forward)} and closes every connection
          at once, until the mode lets forwards through.
        </p>
      </Callout>
    );
  }
  if (state.state === "failed") {
    return (
      <Callout tone="error" title="Failed">
        <p className="break-words">{state.error.message}</p>
        <p className="text-muted-foreground">
          It still listens on {addressOf(forward)} and closes every connection
          at once.
        </p>
      </Callout>
    );
  }
  return null;
}
