import type { FC } from "react";
import {
  Radio,
  Layers,
  Database,
  Box,
  Activity,
  type LucideIcon,
} from "lucide-react";
import type { View } from "@/store/ui";
import { SubjectsView } from "./SubjectsView";

// Sidebar views (VS Code "viewlets"). One registry drives the activity bar and
// the sidebar body. Record<View, …> makes a missing entry a compile error
// (no more silent blank headers). A view without a Panel shows "coming soon".
interface ViewDef {
  title: string;
  icon: LucideIcon;
  Panel?: FC<{ filter: string }>;
}

export const VIEWS: Record<View, ViewDef> = {
  subjects: { title: "Subjects", icon: Radio, Panel: SubjectsView },
  jetstream: { title: "Streams & Consumers", icon: Layers },
  kv: { title: "KV Buckets", icon: Database },
  objectstore: { title: "Object Stores", icon: Box },
  monitor: { title: "Monitoring", icon: Activity },
};

export const VIEW_ORDER = Object.keys(VIEWS) as View[];
