const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

const DECIMAL = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

/** A size in bytes in binary units: `12 B`, `4.5 KiB`. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : DECIMAL.format(value)} ${UNITS[unit]}`;
}
