import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

test("the flash animates only opacity, which leaves the page asleep", () => {
  const theme = readFileSync(join(import.meta.dirname, "theme.css"), "utf8");
  const keyframes = /@keyframes flash \{([\s\S]*?)\n {2}\}/.exec(theme)?.[1];
  const properties = [...(keyframes ?? "").matchAll(/([a-z-]+):/g)].map(
    ([, name]) => name,
  );
  expect(new Set(properties)).toEqual(new Set(["opacity"]));
});
