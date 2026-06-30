import { Boxes } from "lucide-react";
import { registerDomain } from "@/shell/domains";
import { K8sClusterBar } from "@/components/views/k8s/K8sClusterBar";
import { registerK8sViews } from "./views";

// The Kubernetes domain module: a sibling to the NATS module that contributes a
// domain, its views and a connection bar through the same shell registries - the
// workbench shell needs no changes. Mock data only for now (no backend); the
// wiring is what the MVP demonstrates.
let registered = false;

export function registerK8sModule(): void {
  if (registered) return;
  registered = true;

  registerDomain({
    id: "kubernetes",
    title: "Kubernetes",
    icon: Boxes,
    order: 2,
    ConnectionBar: K8sClusterBar,
  });
  registerK8sViews();
}
