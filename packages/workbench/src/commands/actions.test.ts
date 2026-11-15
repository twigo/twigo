import { act } from "@testing-library/react";
import { Trash2 } from "lucide-react";
import { expect, test, vi } from "vitest";
import type { Lookup } from "../contextkey/when";
import { testWorkbench } from "../testing";

async function withScale() {
  const workbench = await testWorkbench();
  const run = vi.fn();
  workbench.commands.register({
    id: "scale",
    title: "Scale…",
    category: "Resource",
    enablement: "resource.selected",
    requires: [
      { when: "resource.capability.patch", reason: "You may not patch it" },
      { when: "resource.capability.scale", reason: "You may not scale it" },
    ],
    sends: "write",
    run,
  });
  workbench.commands.register({
    id: "delete",
    title: "Delete",
    category: "Resource",
    icon: Trash2,
    danger: true,
    sends: "write",
    run,
  });
  workbench.commands.register({
    id: "logs",
    title: "Logs",
    category: "Resource",
    run,
  });
  workbench.menus.append("resource/details", {
    command: "logs",
    group: "navigation",
    pin: "resource.kind == Pod",
  });
  workbench.menus.append("resource/details", {
    command: "scale",
    group: "5_actions",
    pin: "true",
  });
  workbench.menus.append("resource/details", {
    command: "delete",
    group: "9_delete",
  });
  return { workbench, run };
}

const keys =
  (values: Record<string, string | boolean>, base: Lookup): Lookup =>
  (key) =>
    key in values ? values[key] : base(key);

test("a menu's actions say which are pinned, why one cannot run, and which destroys", async () => {
  const { workbench } = await withScale();
  act(() => {
    workbench.spaces.select("dev");
  });
  const base = workbench.keys.lookup(null);
  const lookup = keys(
    {
      "resource.kind": "Pod",
      "resource.selected": true,
      "resource.capability.patch": true,
      "resource.capability.scale": false,
    },
    base,
  );
  const [logs, scale, remove] = workbench.actions("resource/details", lookup);
  expect(logs?.[0]).toMatchObject({ id: "logs", pinned: true });
  expect(scale?.[0]).toMatchObject({
    id: "scale",
    pinned: true,
    disabled: true,
    reason: "You may not scale it",
  });
  expect(scale?.[0]?.locked).toBeUndefined();
  expect(remove?.[0]).toMatchObject({ id: "delete", danger: true });
  expect(remove?.[0]?.pinned).toBeUndefined();
  expect(remove?.[0]?.locked).toBeUndefined();

  const node = keys({ "resource.kind": "Node" }, lookup);
  expect(workbench.actions("resource/details", node)[0]?.[0]?.pinned).toBe(
    undefined,
  );
  expect(
    workbench.commands.enabled(
      "scale",
      keys({ "resource.capability.scale": true }, lookup),
    ),
  ).toBe(true);
});

test("on a read-only context what sends a write is locked and still runs, and what cannot run says its own reason", async () => {
  const { workbench, run } = await withScale();
  act(() => {
    workbench.spaces.select("prod-eu");
  });
  const base = workbench.keys.lookup(null);
  const allowed = keys(
    {
      "resource.selected": true,
      "resource.capability.patch": true,
      "resource.capability.scale": true,
    },
    base,
  );
  const [, [scale] = [], [remove] = []] = workbench.actions(
    "resource/details",
    allowed,
  );
  expect(scale).toMatchObject({
    locked: true,
    disabled: false,
    reason: "prod-eu is read-only",
  });
  expect(remove).toMatchObject({
    locked: true,
    reason: "prod-eu is read-only",
  });
  scale?.run();
  await vi.waitFor(() => {
    expect(run).toHaveBeenCalledOnce();
  });

  const refused = keys({ "resource.capability.patch": false }, allowed);
  const [, [held] = []] = workbench.actions("resource/details", refused);
  expect(held).toMatchObject({
    disabled: true,
    reason: "You may not patch it",
  });
  expect(held?.locked).toBeUndefined();
  expect(workbench.actions("resource/details", base)[0]?.[0]?.locked).toBe(
    undefined,
  );
});
