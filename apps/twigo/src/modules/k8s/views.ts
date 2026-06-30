import { Box, Rocket, Network, Server } from "lucide-react";
import { registerView } from "@/shell/views";
import { PodsView } from "@/components/views/k8s/PodsView";
import { DeploymentsView } from "@/components/views/k8s/DeploymentsView";
import { ServicesView } from "@/components/views/k8s/ServicesView";
import { NodesView } from "@/components/views/k8s/NodesView";

// The Kubernetes sidebar views, tagged with the "kubernetes" domain so the shell
// shows them only while that domain is active.
export function registerK8sViews(): void {
  registerView({
    id: "k8s.pods",
    title: "Pods",
    icon: Box,
    domain: "kubernetes",
    default: true,
    Panel: PodsView,
  });
  registerView({
    id: "k8s.deployments",
    title: "Deployments",
    icon: Rocket,
    domain: "kubernetes",
    Panel: DeploymentsView,
  });
  registerView({
    id: "k8s.services",
    title: "Services",
    icon: Network,
    domain: "kubernetes",
    Panel: ServicesView,
  });
  registerView({
    id: "k8s.nodes",
    title: "Nodes",
    icon: Server,
    domain: "kubernetes",
    Panel: NodesView,
  });
}
