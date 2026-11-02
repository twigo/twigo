import { expect, test } from "vitest";
import { formatBytes } from "./bytes";

test.each([
  [0, "0 B"],
  [1023, "1023 B"],
  [1024, "1 KiB"],
  [4608, "4.5 KiB"],
  [5 * 1024 * 1024, "5 MiB"],
])("%d bytes read %s", (bytes, text) => {
  expect(formatBytes(bytes)).toBe(text);
});
