import type { K8sStatus } from "@/components/views/k8s/ResourceList";

// Static fixtures so the Kubernetes domain is explorable without a backend. A
// real module would replace this with kube-rs watches over Tauri events; the
// view/registry wiring stays identical.

export interface PodRow {
  name: string;
  namespace: string;
  status: K8sStatus;
  phase: string;
  restarts: number;
}

export interface DeploymentRow {
  name: string;
  namespace: string;
  ready: number;
  desired: number;
}

export interface ServiceRow {
  name: string;
  namespace: string;
  type: string;
  clusterIp: string;
}

export interface NodeRow {
  name: string;
  role: string;
  status: K8sStatus;
  ready: boolean;
  version: string;
}

export const CLUSTERS = ["minikube", "prod-eu-1", "staging"] as const;

export const PODS: PodRow[] = [
  { name: "api-7d9f8c-2xk4l", namespace: "default", status: "ok", phase: "Running", restarts: 0 },
  { name: "api-7d9f8c-9whp2", namespace: "default", status: "ok", phase: "Running", restarts: 1 },
  { name: "web-5c4b9d-qp7nz", namespace: "default", status: "ok", phase: "Running", restarts: 0 },
  { name: "worker-6f8a-mk20d", namespace: "jobs", status: "warn", phase: "Pending", restarts: 0 },
  { name: "billing-84cd-rt9xv", namespace: "payments", status: "error", phase: "CrashLoopBackOff", restarts: 7 },
  { name: "nats-0", namespace: "messaging", status: "ok", phase: "Running", restarts: 0 },
  { name: "prometheus-0", namespace: "observability", status: "ok", phase: "Running", restarts: 2 },
];

export const DEPLOYMENTS: DeploymentRow[] = [
  { name: "api", namespace: "default", ready: 2, desired: 2 },
  { name: "web", namespace: "default", ready: 1, desired: 1 },
  { name: "worker", namespace: "jobs", ready: 0, desired: 1 },
  { name: "billing", namespace: "payments", ready: 0, desired: 2 },
];

export const SERVICES: ServiceRow[] = [
  { name: "api", namespace: "default", type: "ClusterIP", clusterIp: "10.96.0.12" },
  { name: "web", namespace: "default", type: "LoadBalancer", clusterIp: "10.96.0.41" },
  { name: "nats", namespace: "messaging", type: "ClusterIP", clusterIp: "10.96.0.88" },
  { name: "prometheus", namespace: "observability", type: "ClusterIP", clusterIp: "10.96.0.90" },
];

export const NODES: NodeRow[] = [
  { name: "cp-1", role: "control-plane", status: "ok", ready: true, version: "v1.30.2" },
  { name: "worker-1", role: "worker", status: "ok", ready: true, version: "v1.30.2" },
  { name: "worker-2", role: "worker", status: "ok", ready: true, version: "v1.30.2" },
  { name: "worker-3", role: "worker", status: "error", ready: false, version: "v1.30.1" },
];
