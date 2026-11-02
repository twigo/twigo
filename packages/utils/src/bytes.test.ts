import { expect, test } from "vitest";
import { formatBytes } from "./bytes";

test.each([
  [0, "0 B"],
  [1023, "1023 B"],
  [1024, "1 KiB"],
  [4608, "4.5 KiB"],
  [1048575, "1 MiB"],
  [5 * 1024 * 1024, "5 MiB"],
  [1000 * 1024 * 1024, "1000 MiB"],
])("%d bytes read %s", (bytes, text) => {
  expect(formatBytes(bytes)).toBe(text);
});
