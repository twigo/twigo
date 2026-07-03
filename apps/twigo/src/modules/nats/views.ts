import {
  Radio,
  Webhook,
  Layers,
  Database,
  Box,
  Activity,
  Server,
  History,
} from "lucide-react";
import { registerView } from "@/shell/views";
import { SubjectsView } from "@/components/views/subjects/SubjectsView";
import { RespondersView } from "@/components/views/responders/RespondersView";
import { JetStreamView } from "@/components/views/jetstream/JetStreamView";
import { KvView } from "@/components/views/kv/KvView";
import { ObjectStoreView } from "@/components/views/objstore/ObjectStoreView";
import { MonitorView } from "@/components/views/monitor/MonitorView";
import { ServicesView } from "@/components/views/services/ServicesView";
import { HistoryView } from "@/components/views/history/HistoryView";

// The NATS sidebar views, in display order. Contributed to the shell's view
// registry by registerNatsModule(), tagged with the "nats" domain so the shell
// shows them only while that domain is active.
export function registerNatsViews(): void {
  registerView({
    id: "jetstream",
    title: "Streams & Consumers",
    icon: Layers,
    domain: "nats",
    default: true,
    Panel: JetStreamView,
  });
  registerView({
    id: "kv",
    title: "KV Buckets",
    icon: Database,
    domain: "nats",
    Panel: KvView,
  });
  registerView({
    id: "objectstore",
    title: "Object Stores",
    icon: Box,
    domain: "nats",
    Panel: ObjectStoreView,
  });
  registerView({
    id: "subjects",
    title: "Subjects",
    icon: Radio,
    domain: "nats",
    Panel: SubjectsView,
  });
  registerView({
    id: "responders",
    title: "Responders",
    icon: Webhook,
    domain: "nats",
    Panel: RespondersView,
  });
  registerView({
    id: "history",
    title: "Sent History",
    icon: History,
    domain: "nats",
    Panel: HistoryView,
  });
  registerView({
    id: "services",
    title: "Services",
    icon: Server,
    domain: "nats",
    Panel: ServicesView,
  });
  registerView({
    id: "monitor",
    title: "Monitoring",
    icon: Activity,
    domain: "nats",
    Panel: MonitorView,
  });
}
