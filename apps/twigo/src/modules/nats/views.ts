import { Radio, Webhook, Layers, Database, Box, Activity } from "lucide-react";
import { registerView } from "@/shell/views";
import { SubjectsView } from "@/components/views/subjects/SubjectsView";
import { RespondersView } from "@/components/views/responders/RespondersView";
import { JetStreamView } from "@/components/views/jetstream/JetStreamView";
import { KvView } from "@/components/views/kv/KvView";
import { ObjectStoreView } from "@/components/views/objstore/ObjectStoreView";
import { MonitorView } from "@/components/views/monitor/MonitorView";

// The NATS sidebar views, in display order. Contributed to the shell's view
// registry by registerNatsModule().
export function registerNatsViews(): void {
  registerView({
    id: "jetstream",
    title: "Streams & Consumers",
    icon: Layers,
    default: true,
    Panel: JetStreamView,
  });
  registerView({
    id: "kv",
    title: "KV Buckets",
    icon: Database,
    Panel: KvView,
  });
  registerView({
    id: "objectstore",
    title: "Object Stores",
    icon: Box,
    Panel: ObjectStoreView,
  });
  registerView({
    id: "subjects",
    title: "Subjects",
    icon: Radio,
    Panel: SubjectsView,
  });
  registerView({
    id: "responders",
    title: "Responders",
    icon: Webhook,
    Panel: RespondersView,
  });
  registerView({
    id: "monitor",
    title: "Monitoring",
    icon: Activity,
    Panel: MonitorView,
  });
}
