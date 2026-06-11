import {
  Radio,
  X,
  Settings,
  Server,
  Send,
  Webhook,
  Layers,
  ArrowDownToLine,
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
  const { connId, subject, payload, seed } = props.params as {
    connId: string;
    subject?: string;
    payload?: string;
    seed?: number;
  };
  return (
    <PublishEditor
      key={seed}
      connId={connId}
      initialSubject={subject ?? ""}
      initialPayload={payload ?? ""}
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

// Close button shows only on the active/hovered tab (styled in index.css).
function ClosableTab({
  icon: Icon,
  title,
  mono,
  iconClass,
  onClose,
}: {
  icon: LucideIcon;
  title: string | undefined;
  mono?: boolean;
  iconClass?: string;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full items-center gap-2 pl-3 pr-2 text-xs">
      <Icon className={cn("size-3 shrink-0", iconClass)} />
      <span className={cn("max-w-44 truncate", mono && "font-mono")}>
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
      iconClass="text-brand"
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
      iconClass="text-brand"
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
      iconClass="text-brand"
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
      iconClass="text-brand"
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
      iconClass="text-muted-foreground"
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
      iconClass="text-brand"
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
      iconClass="text-brand"
      mono
      title={props.api.title}
      onClose={() => {
        props.api.close();
      }}
    />
  );
}
