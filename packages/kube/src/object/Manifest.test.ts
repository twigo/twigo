import { expect, test } from "vitest";
import { yamlOf } from "./Manifest";

test("strings YAML 1.1 reads as booleans stay quoted", () => {
  const yaml = yamlOf(
    JSON.stringify({ data: { enabled: "yes", flag: "on", mode: "fast" } }),
  );
  expect(yaml).toContain('enabled: "yes"');
  expect(yaml).toContain('flag: "on"');
  expect(yaml).toContain("mode: fast");
});
