/** Whether two values of plain data are the same, as their JSON tells them apart: their keys in the same order. */
export function sameData(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
