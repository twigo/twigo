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

/**
 * The widest text `humanDuration` gives anywhere in the range of ages that
 * `ms` falls in, as its forms change with the range: seconds, minutes and
 * seconds, minutes, hours and minutes, hours, days and hours, days, years and
 * days, years, and `<invalid>` for a time ahead of now by 2 s or more, which a
 * clock behind the server's gives. Digits are as wide as each other in tabular
 * figures, so the room it takes is the room any age of the range takes.
 */
export function widestDuration(ms: number): string {
  const seconds = Math.trunc(ms / 1000);
  if (seconds < -1) return "<invalid>";
  if (seconds < 2 * MINUTE) return "119s";
  const minutes = Math.trunc(seconds / MINUTE);
  if (minutes < 10) return "9m59s";
  if (minutes < 3 * 60) return "179m";
  const hours = Math.trunc(seconds / HOUR);
  if (hours < 8) return "7h59m";
  if (hours < 48) return "47h";
  if (hours < 8 * 24) return "7d23h";
  if (seconds < 2 * YEAR) return "729d";
  if (seconds < 8 * YEAR) return "7y364d";
  return "99y";
}

const UNITS = /^(?:(\d+)y)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

/**
 * The inverse of `humanDuration`: reads a duration as kubectl prints it,
 * years, days, hours, minutes and seconds in that order (`2d1h`, `5m30s`),
 * and returns undefined for anything else, as `<unknown>` and `<invalid>`.
 */
export function parseDuration(text: string): number | undefined {
  const match = text === "" ? null : UNITS.exec(text);
  if (!match) return undefined;
  const [, y, d, h, m, s] = match;
  const hours = (Number(y ?? 0) * 365 + Number(d ?? 0)) * 24 + Number(h ?? 0);
  return ((hours * 60 + Number(m ?? 0)) * 60 + Number(s ?? 0)) * 1000;
}
