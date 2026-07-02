import { create } from "zustand";
import { CLUSTERS } from "./mock";

// The active mock cluster, shared by the cluster bar and the space-tab target
// hook so a "K8s · prod-eu-1" tab really switches the module's context.
interface ClusterState {
  selected: string;
  select: (id: string) => void;
}

export const useCluster = create<ClusterState>((set) => ({
  selected: CLUSTERS[0],
  select: (selected) => set({ selected }),
}));
