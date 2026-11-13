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
