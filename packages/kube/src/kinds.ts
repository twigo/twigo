import {
  Archive,
  Box,
  Boxes,
  CalendarClock,
  CirclePlay,
  Copy,
  Cylinder,
  Database,
  FileCog,
  Folder,
  Gauge,
  Globe,
  HardDrive,
  Hexagon,
  IdCard,
  KeyRound,
  Layers,
  Link,
  Puzzle,
  Scale,
  Server,
  ShieldCheck,
  ShieldHalf,
  Spline,
  TimerReset,
  Waypoints,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { Gvr } from "@twigo/protocol";

/** Lucide icons for the built-in kinds, by resource (ARCHITECTURE 4.9). */
const ICONS: Readonly<Record<string, LucideIcon>> = {
  pods: Box,
  deployments: Layers,
  replicasets: Copy,
  statefulsets: Database,
  daemonsets: Boxes,
  jobs: CirclePlay,
  cronjobs: CalendarClock,
  horizontalpodautoscalers: Gauge,
  poddisruptionbudgets: Scale,
  services: Waypoints,
  ingresses: Globe,
  endpointslices: Spline,
  networkpolicies: ShieldHalf,
  configmaps: FileCog,
  secrets: KeyRound,
  persistentvolumeclaims: HardDrive,
  persistentvolumes: Cylinder,
  storageclasses: Archive,
  nodes: Server,
  namespaces: Folder,
  serviceaccounts: IdCard,
  roles: ShieldCheck,
  clusterroles: ShieldCheck,
  rolebindings: Link,
  clusterrolebindings: Link,
  leases: TimerReset,
  events: Zap,
  customresourcedefinitions: Puzzle,
};

/** Custom resources, whose groups always hold a dot, get the generic icon. */
export function kindIcon(gvr: Gvr): LucideIcon {
  const builtIn = !gvr.group.includes(".") || gvr.group.endsWith(".k8s.io");
  return (builtIn ? ICONS[gvr.resource] : undefined) ?? Hexagon;
}

export const PODS: Gvr = { group: "", version: "v1", resource: "pods" };
