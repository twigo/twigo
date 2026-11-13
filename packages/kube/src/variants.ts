import {
  formatCpu,
  formatCpuAdaptive,
  formatMemory,
  formatMemoryAdaptive,
} from "@twigo/utils";

/**
 * The choices of step 9's checkpoint, picked in the address as
 * `?variant=units:adaptive,usage:text`: the first of each is the default.
 * Choosing one keeps its branch and deletes this file and the others.
 */
const CHOICES = {
  units: ["kubectl", "adaptive"],
  empty: ["dash", "blank"],
  usage: ["meters", "text"],
  place: ["section", "containers"],
} as const;

type Choices = typeof CHOICES;

export function variant<K extends keyof Choices>(name: K): Choices[K][number] {
  const asked = new URLSearchParams(location.search)
    .getAll("variant")
    .flatMap((value) => value.split(","));
  for (const entry of asked) {
    const [key, option] = entry.split(":");
    const found = CHOICES[name].find((candidate) => candidate === option);
    if (key === name && found !== undefined) return found;
  }
  return CHOICES[name][0];
}

const FORMATS = {
  kubectl: { cpu: formatCpu, memory: formatMemory },
  adaptive: { cpu: formatCpuAdaptive, memory: formatMemoryAdaptive },
};

export function measureFormat(
  resource: "cpu" | "memory",
): (value: number) => string {
  return FORMATS[variant("units")][resource];
}

export function noSample(): string {
  return variant("empty") === "dash" ? "–" : "";
}
