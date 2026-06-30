import {
  Radio,
  X,
  Settings,
  Server,
  Send,
  Webhook,
  Layers,
  ArrowDownToLine,
  Database,
  Box,
  Activity,
  type LucideIcon,
} from "lucide-react";
import type {
  IDockviewPanelProps,
  IDockviewPanelHeaderProps,
} from "dockview-react";
import { cn } from "@twigo/ui";
import { MessageStream } from "./MessageStream";
import { ServerInfoPanel } from "./ServerInfoPanel";
import { PublishEditor } from "./PublishEditor";
import { ResponderEditor } from "./ResponderEditor";
import { StreamDetailPanel } from "./jetstream/StreamDetailPanel";
import { ConsumerDetailPanel } from "./jetstream/ConsumerDetailPanel";
import { KvEntryDetailPanel } from "./kv/KvEntryDetailPanel";
import { ObjectDetailPanel } from "./objstore/ObjectDetailPanel";
import { ServerHealthPanel } from "./monitor/ServerHealthPanel";
import { ServiceDetailPanel } from "./services/ServiceDetailPanel";
import { SettingsPage } from "@/components/settings/SettingsPage";

export function StreamPanel(props: IDockviewPanelProps) {
  const { streamId } = props.params as { streamId: string };
  return <MessageStream streamId={streamId} />;
}

export function ServerPanel(props: IDockviewPanelProps) {
  const { connId } = props.params as { connId: string };
  return <ServerInfoPanel connId={connId} />;
}

export function PublishPanel(props: IDockviewPanelProps) {
  const { connId, subject, payload, headers, seed } = props.params as {
    connId: string;
    subject?: string;
    payload?: string;
    headers?: [string, string][];
    seed?: number;
  };
  return (
    <PublishEditor
      key={seed}
      connId={connId}
      initialSubject={subject ?? ""}
      initialPayload={payload ?? ""}
      initialHeaders={headers}
    />
  );
}

export function ResponderPanel(props: IDockviewPanelProps) {
  const { id, connId, subject } = props.params as {
    id: string;
    connId: string;
    subject?: string;
  };
  return (
    <ResponderEditor id={id} connId={connId} initialSubject={subject ?? ""} />
  );
}

export function SettingsPanel() {
  return <SettingsPage />;
}

export function JsStreamPanel(props: IDockviewPanelProps) {
  const { connId, stream } = props.params as {
    connId: string;
    stream: string;
  };
  return <StreamDetailPanel connId={connId} stream={stream} />;
}

export function KvEntryPanel(props: IDockviewPanelProps) {
  const { connId, bucket, key } = props.params as {
    connId: string;
    bucket: string;
    key: string;
  };
  return <KvEntryDetailPanel connId={connId} bucket={bucket} kvkey={key} />;
}

export function ObjectPanel(props: IDockviewPanelProps) {
  const { connId, bucket, name } = props.params as {
    connId: string;
    bucket: string;
    name: string;
  };
  return <ObjectDetailPanel connId={connId} bucket={bucket} name={name} />;
}

export function ServicePanel(props: IDockviewPanelProps) {
  const { connId, name, id } = props.params as {
    connId: string;
    name: string;
    id: string;
  };
  return <ServiceDetailPanel connId={connId} name={name} id={id} />;
}

export function ServerHealthPanelHost(props: IDockviewPanelProps) {
  const { connId } = props.params as { connId: string };
  return <ServerHealthPanel connId={connId} />;
}

export function JsConsumerPanel(props: IDockviewPanelProps) {
  const { connId, stream, consumer } = props.params as {
    connId: string;
    stream: string;
    consumer: string;
  };
  return (
    <ConsumerDetailPanel connId={connId} stream={stream} consumer={consumer} />
  );
}

// The type icon is monochrome (inherits the tab's text colour, fades when
// inactive); the one accent on the bar is the selected chip's azure tint. The
// close X keeps a fixed size so the tab width never shifts on hover.
function ClosableTab({
  icon: Icon,
  title,
  mono,
  onClose,
}: {
  icon: LucideIcon;
  title: string | undefined;
  mono?: boolean;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full items-center gap-1.5 pl-3 pr-2 text-[13px]">
      <Icon className="size-3.5 shrink-0" />
      <span className={cn("max-w-44 truncate", mono && "font-mono text-xs")}>
        {title}
      </span>
      <button
        type="button"
        aria-label="Close tab"
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="twigo-tab-close flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

export function StreamTab(props: IDockviewPanelHeaderProps) {
  return (
    <ClosableTab
      icon={Radio}
      mono
      title={props.api.title}
      onClose={() => {
        props.api.close();
      }}
    />
  );
}

export function ServerTab(props: IDockviewPanelHeaderProps) {
  return (
    <ClosableTab
      icon={Server}
      mono
      title={props.api.title}
      onClose={() => {
        props.api.close();
      }}
    />
  );
}

export function PublishTab(props: IDockviewPanelHeaderProps) {
  return (
    <ClosableTab
      icon={Send}
      title={props.api.title}
      onClose={() => {
        props.api.close();
      }}
    />
  );
}

export function ResponderTab(props: IDockviewPanelHeaderProps) {
  return (
    <ClosableTab
      icon={Webhook}
      title={props.api.title}
      onClose={() => {
        props.api.close();
      }}
    />
  );
}

export function SettingsTab(props: IDockviewPanelHeaderProps) {
  return (
    <ClosableTab
      icon={Settings}
      title={props.api.title}
      onClose={() => {
        props.api.close();
      }}
    />
  );
}

export function JsStreamTab(props: IDockviewPanelHeaderProps) {
  return (
    <ClosableTab
      icon={Layers}
      mono
      title={props.api.title}
      onClose={() => {
        props.api.close();
      }}
    />
  );
}

export function KvEntryTab(props: IDockviewPanelHeaderProps) {
  return (
    <ClosableTab
      icon={Database}
      mono
      title={props.api.title}
      onClose={() => {
        props.api.close();
      }}
    />
  );
}

export function ObjectTab(props: IDockviewPanelHeaderProps) {
  return (
    <ClosableTab
      icon={Box}
      mono
      title={props.api.title}
      onClose={() => {
        props.api.close();
      }}
    />
  );
}

export function ServerHealthTab(props: IDockviewPanelHeaderProps) {
  return (
    <ClosableTab
      icon={Activity}
      title={props.api.title}
      onClose={() => {
        props.api.close();
      }}
    />
  );
}

export function ServiceTab(props: IDockviewPanelHeaderProps) {
  return (
    <ClosableTab
      icon={Server}
      mono
      title={props.api.title}
      onClose={() => {
        props.api.close();
      }}
    />
  );
}

export function JsConsumerTab(props: IDockviewPanelHeaderProps) {
  return (
    <ClosableTab
      icon={ArrowDownToLine}
      mono
      title={props.api.title}
      onClose={() => {
        props.api.close();
      }}
    />
  );
}
