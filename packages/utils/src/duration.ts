const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

/**
 * Formats a duration in milliseconds as kube-apiserver formats Age cells, a
 * port of HumanDuration in
 * https://github.com/kubernetes/apimachinery/blob/v0.37.1/pkg/util/duration/duration.go
 */
export function humanDuration(ms: number): string {
  const seconds = Math.trunc(ms / 1000);
  if (seconds < -1) return "<invalid>";
  if (seconds < 0) return "0s";
  if (seconds < 2 * MINUTE) return `${seconds}s`;
  const minutes = Math.trunc(seconds / MINUTE);
  if (minutes < 10) {
    const s = seconds % MINUTE;
    return s === 0 ? `${minutes}m` : `${minutes}m${s}s`;
  }
  if (minutes < 3 * 60) return `${minutes}m`;
  const hours = Math.trunc(seconds / HOUR);
  if (hours < 8) {
    const m = minutes % 60;
    return m === 0 ? `${hours}h` : `${hours}h${m}m`;
  }
  if (hours < 48) return `${hours}h`;
  const days = Math.trunc(seconds / DAY);
  if (hours < 8 * 24) {
    const h = hours % 24;
    return h === 0 ? `${days}d` : `${days}d${h}h`;
  }
  if (seconds < 2 * YEAR) return `${days}d`;
  const years = Math.trunc(seconds / YEAR);
  if (seconds < 8 * YEAR) {
    const d = days % 365;
    return d === 0 ? `${years}y` : `${years}y${d}d`;
  }
  return `${years}y`;
}
