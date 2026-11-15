import { expect, test } from "vitest";
import { Commands } from "./registry";

const command = (id: string, enablement?: string, requires: string[] = []) => ({
  id,
  title: id,
  category: "Resource",
  ...(enablement !== undefined && { enablement }),
  requires: requires.map((when) => ({ when, reason: `${when} fails` })),
  run: () => undefined,
});

test("referenced lists the keys under a prefix that enablements and requirements read, sorted, and follows registrations", () => {
  const commands = new Commands(() => undefined);
  commands.register(
    command("scale", "resource.selected", ["resource.capability.scale"]),
  );
  const capabilities = () => commands.referenced("resource.capability.");
  expect(capabilities()).toEqual(["resource.capability.scale"]);
  expect(commands.referenced("resource.")).toEqual([
    "resource.capability.scale",
    "resource.selected",
  ]);
  expect(capabilities()).toBe(capabilities());

  const unregister = commands.register(
    command("patch", undefined, ["resource.capability.patch"]),
  );
  expect(capabilities()).toEqual([
    "resource.capability.patch",
    "resource.capability.scale",
  ]);
  unregister();
  expect(capabilities()).toEqual(["resource.capability.scale"]);
});
