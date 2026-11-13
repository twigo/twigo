const MILLI = 1_000_000;
const MI = 1024 * 1024;

/**
 * A CPU measure in nanocores as `kubectl top` prints it: whole millicores,
 * rounded up, as [`MilliValue`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apimachinery/pkg/api/resource/quantity.go#L818-L822)
 * is `ceil(q * 1000)` ([`printSingleResourceUsage`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/metricsutil/metrics_printer.go#L244-L253)).
 */
export function formatCpu(nanocores: number): string {
  return `${String(Math.ceil(nanocores / MILLI))}m`;
}

/**
 * A memory measure in bytes as `kubectl top` prints it: whole Mi, rounded
 * down, since it divides the byte count as integers.
 */
export function formatMemory(bytes: number): string {
  return `${String(Math.floor(bytes / MI))}Mi`;
}

const GI = 1024 * MI;

function trimmed(value: number, digits: number): string {
  return String(Number(value.toFixed(digits)));
}

/** A CPU as `12m` below a core, and in cores from one up: `1.25`. */
export function formatCpuAdaptive(nanocores: number): string {
  const millicores = Math.ceil(nanocores / MILLI);
  return millicores < 1000
    ? `${String(millicores)}m`
    : trimmed(millicores / 1000, 2);
}

/** A memory as `34Mi` below a Gi, and in Gi from one up, rounded down: `1.5Gi`. */
export function formatMemoryAdaptive(bytes: number): string {
  return bytes < GI
    ? formatMemory(bytes)
    : `${trimmed(Math.floor((bytes / GI) * 100) / 100, 2)}Gi`;
}
