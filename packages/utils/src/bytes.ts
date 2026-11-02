const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

const DECIMAL = new Intl.NumberFormat("en", {
  maximumFractionDigits: 1,
  useGrouping: false,
});

/** The value as shown in its unit: whole bytes, else one decimal. */
function shown(value: number, unit: number): number {
  return unit === 0 ? value : Math.round(value * 10) / 10;
}

/** A size in bytes in binary units: `12 B`, `4.5 KiB`, never `1024 KiB`. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (unit < UNITS.length - 1 && shown(value, unit) >= 1024) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : DECIMAL.format(value)} ${UNITS[unit]}`;
}
