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
import {
  addressOf,
  forwardTitle,
  listensOn,
  portWords,
  stateOf,
} from "./words";

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
  const forward = input && forwards.find(input);
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
        title="Port-forward not found"
        action={{
          label: "Close",
          onClick: () => {
            editors.close(uri);
          },
        }}
        className="h-full"
      >
        <p>It was not found, so there is nothing to show.</p>
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
  const listens = listensOn(forward);
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
        <StatusLabel
          tone={shown.tone}
          {...(shown.pulse && { pulse: true })}
          {...(shown.hollow && { hollow: true })}
        >
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
          <Quiet>
            {listens.length > 0
              ? ` on ${listens.join(" and ")}`
              : " not listening"}
          </Quiet>
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
    {
      key: "sent",
      label: "Sent",
      value: (
        <>
          {formatBytes(forward.sent)}
          <Quiet> since Twigo started</Quiet>
        </>
      ),
    },
    {
      key: "received",
      label: "Received",
      value: (
        <>
          {formatBytes(forward.received)}
          <Quiet> since Twigo started</Quiet>
        </>
      ),
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
        <Banner tone="info" icon={Info} title="Restored.">
          It listens on {addressOf(forward)} and asks its cluster at the first
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
        <p className="text-muted-foreground">
          It looks again while it has connections, and at its next one.
        </p>
      </Callout>
    );
  }
  if (state.state !== "failed") return null;
  const { error } = state;
  const where = addressOf(forward);
  const [title, tone] = error.blocked
    ? [`${error.blocked.context} is ${error.blocked.mode}`, "warn" as const]
    : ["Failed", "error" as const];
  const listens = listensOn(forward).length > 0;
  return (
    <Callout tone={tone} title={title}>
      <p className="break-words">{error.message}</p>
      <p className="text-muted-foreground">
        {!listens
          ? `Nothing listens on ${where}. Change Local Port… moves it to another port, and Start tries this one again.`
          : error.blocked
            ? `It still listens on ${where} and closes every connection at once, until the mode lets forwards through.`
            : `It still listens on ${where}. Start tries it again.`}
      </p>
    </Callout>
  );
}
