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
export const KIND_ICONS: Readonly<Record<string, LucideIcon>> = {
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
  return KIND_ICONS[iconKey(gvr)] ?? Hexagon;
}

/** The key of `KIND_ICONS` for a resource; custom resources have none. */
export function iconKey(gvr: Gvr): string {
  return isBuiltIn(gvr) ? gvr.resource : "";
}

export const PODS: Gvr = { group: "", version: "v1", resource: "pods" };

/** True for the groups Kubernetes itself serves; a custom group holds a dot outside k8s.io. */
export function isBuiltIn(gvr: Gvr): boolean {
  return !gvr.group.includes(".") || gvr.group.endsWith(".k8s.io");
}

/** The explorer's sections for built-in resources, by `group/resource`, after Lens's sidebar. */
const SECTIONS: readonly { title: string; resources: readonly string[] }[] = [
  {
    title: "Workloads",
    resources: [
      "/pods",
      "apps/deployments",
      "apps/daemonsets",
      "apps/statefulsets",
      "apps/replicasets",
      "batch/jobs",
      "batch/cronjobs",
    ],
  },
  {
    title: "Config",
    resources: [
      "/configmaps",
      "/secrets",
      "/resourcequotas",
      "/limitranges",
      "autoscaling/horizontalpodautoscalers",
      "policy/poddisruptionbudgets",
      "scheduling.k8s.io/priorityclasses",
      "node.k8s.io/runtimeclasses",
      "coordination.k8s.io/leases",
      "admissionregistration.k8s.io/mutatingwebhookconfigurations",
      "admissionregistration.k8s.io/validatingwebhookconfigurations",
    ],
  },
  {
    title: "Network",
    resources: [
      "/services",
      "discovery.k8s.io/endpointslices",
      "networking.k8s.io/ingresses",
      "networking.k8s.io/ingressclasses",
      "networking.k8s.io/networkpolicies",
    ],
  },
  {
    title: "Storage",
    resources: [
      "/persistentvolumeclaims",
      "/persistentvolumes",
      "storage.k8s.io/storageclasses",
    ],
  },
  {
    title: "Access Control",
    resources: [
      "/serviceaccounts",
      "rbac.authorization.k8s.io/clusterroles",
      "rbac.authorization.k8s.io/roles",
      "rbac.authorization.k8s.io/clusterrolebindings",
      "rbac.authorization.k8s.io/rolebindings",
    ],
  },
  {
    title: "Cluster",
    resources: [
      "/nodes",
      "/namespaces",
      "/events",
      "apiextensions.k8s.io/customresourcedefinitions",
    ],
  },
];

export interface Section<T> {
  readonly title: string;
  readonly items: readonly T[];
  /** Custom resources come in one section, a group per API group, as in Lens. */
  readonly groups: readonly Section<T>[];
}

/**
 * The explorer's sections: the built-in ones in Lens's order, then Custom
 * Resources by API group. Other built-in resources stay out of the tree;
 * quick access still opens them.
 */
export function sections<T extends { readonly gvr: Gvr }>(
  resources: readonly T[],
): Section<T>[] {
  const byKey = new Map(
    resources.map((resource) => [
      `${resource.gvr.group}/${resource.gvr.resource}`,
      resource,
    ]),
  );
  const builtIn = SECTIONS.map(({ title, resources: keys }) => ({
    title,
    items: keys.flatMap((key) => byKey.get(key) ?? []),
    groups: [],
  }));
  const custom = new Map<string, T[]>();
  for (const resource of resources) {
    if (isBuiltIn(resource.gvr)) continue;
    custom.set(resource.gvr.group, [
      ...(custom.get(resource.gvr.group) ?? []),
      resource,
    ]);
  }
  const groups = [...custom.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, items]) => ({ title: group, items, groups: [] }));
  return [
    ...builtIn.filter((section) => section.items.length > 0),
    ...(groups.length > 0
      ? [{ title: "Custom Resources", items: [], groups }]
      : []),
  ];
}

/**
 * A list's title from its kind's words and its resource, the plural that
 * discovery gives: `NetworkPolicy` + `networkpolicies` → `Network Policies`.
 */
export function pluralTitle(kind: string, resource: string): string {
  const words = kind.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ");
  const last = words.pop() ?? "";
  const prefix = words.join("").toLowerCase();
  const plural = resource.startsWith(prefix)
    ? resource.slice(prefix.length)
    : `${last}s`;
  return [...words, plural.charAt(0).toUpperCase() + plural.slice(1)].join(" ");
}
