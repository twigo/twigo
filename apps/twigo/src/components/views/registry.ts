import type { FC } from "react";
import {
  Radio,
  Webhook,
  Layers,
  Database,
  Box,
  Activity,
  type LucideIcon,
} from "lucide-react";
import type { View } from "@/store/ui";
import { SubjectsView } from "./subjects/SubjectsView";
import { RespondersView } from "./responders/RespondersView";
import { JetStreamView } from "./jetstream/JetStreamView";

// Sidebar views (VS Code "viewlets"). One registry drives the activity bar and
// the sidebar body. Record<View, …> makes a missing entry a compile error
// (no more silent blank headers). A view without a Panel shows "coming soon".
export interface ViewProps {
  filter: string;
  connId: string | null;
}

interface ViewDef {
  title: string;
  icon: LucideIcon;
  Panel?: FC<ViewProps>;
}

export const VIEWS: Record<View, ViewDef> = {
  subjects: { title: "Subjects", icon: Radio, Panel: SubjectsView },
  responders: { title: "Responders", icon: Webhook, Panel: RespondersView },
  jetstream: {
    title: "Streams & Consumers",
    icon: Layers,
    Panel: JetStreamView,
  },
  kv: { title: "KV Buckets", icon: Database },
  objectstore: { title: "Object Stores", icon: Box },
  monitor: { title: "Monitoring", icon: Activity },
};

export const VIEW_ORDER = Object.keys(VIEWS) as View[];
