/** One thing the cluster's home asks the person to look at. */
export interface Attention {
  readonly id: string;
  readonly tone: "error" | "warn";
  /** As the cluster says it: `CrashLoopBackOff`. */
  readonly title: string;
  readonly count: number;
  /** What it counts, by the count: `pod` or `pods`. */
  readonly unit: string;
  /** What it means, in words. */
  readonly words?: string;
}

/** What a pod's Status means, for the values the kubelet and the API server print most. */
const POD_STATUS_WORDS: Readonly<Record<string, string>> = {
  CrashLoopBackOff:
    "A container keeps exiting, and the kubelet waits longer before each restart.",
  Error: "A container exited with an error.",
  OOMKilled: "A container went over its memory limit and was killed.",
  ImagePullBackOff:
    "An image could not be pulled, and the kubelet waits before it tries again.",
  ErrImagePull: "An image could not be pulled.",
  InvalidImageName: "An image's name does not parse.",
  CreateContainerConfigError:
    "A container refers to something missing, such as a Secret or a ConfigMap key.",
  CreateContainerError: "The runtime could not create a container.",
  RunContainerError: "The runtime could not start a container.",
  ContainerStatusUnknown: "The kubelet lost track of a container.",
  Evicted: "The kubelet evicted the pod, usually as its node ran short.",
  Unknown: "The pod's node stopped reporting.",
  NodeLost: "The pod's node stopped reporting.",
  Pending: "Not running yet, usually waiting for a node.",
  ContainerCreating: "Its containers are being created.",
  PodInitializing: "Its init containers are done and its containers start.",
  Terminating: "Being deleted while its containers stop.",
};

const INIT_WORDS = "Its init containers have not finished.";

/** A pod's Status in words, if it is one the home knows. */
export function podStatusWords(status: string): string | undefined {
  return (
    POD_STATUS_WORDS[status] ??
    (status.startsWith("Init:") ? INIT_WORDS : undefined)
  );
}

/** `1 pod`, `2 pods`: the unit by its count. */
export function unit(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** A regex text filter that keeps the cells that read exactly `text`, in any case. */
export function exactly(text: string): string {
  return `/^${text.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&")}$/`;
}
