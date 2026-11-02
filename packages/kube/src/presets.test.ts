import { expect, test } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { StateStore } from "@twigo/workbench";
import { PODS } from "./kinds";
import { ListPresets } from "./presets";

const KEY = "list//pods";

async function presets(backend = createMockBackend("ready")) {
  const state = await StateStore.load(backend, () => undefined);
  return { presets: new ListPresets(state), state };
}

test("columns, widths and grouping join the stored preset and come back in the next window", async () => {
  const backend = createMockBackend("ready");
  await backend.invoke("state_set", [
    {
      space: null,
      key: KEY,
      value: JSON.stringify({ columns: { IP: true }, widths: {} }),
    },
  ]);
  const first = await presets(backend);
  expect(first.presets.get(PODS).columns).toEqual({ IP: true });
  first.presets.showColumn(PODS, "Node", true);
  first.presets.resize(PODS, "Name", 311.6);
  first.presets.groupBy(PODS, "Namespace");

  await first.state.settled();
  const next = await presets(backend);
  expect(next.presets.get(PODS)).toEqual({
    columns: { IP: true, Node: true },
    widths: { Name: 312 },
    group: "Namespace",
  });
  next.presets.groupBy(PODS, undefined);
  expect(next.presets.get(PODS).group).toBeUndefined();
});

test("stored values that do not fit read as none, field by field", async () => {
  const backend = createMockBackend("ready");
  await backend.invoke("state_set", [
    {
      space: null,
      key: KEY,
      value: JSON.stringify({
        columns: { IP: "yes" },
        widths: { Name: -1 },
        group: "Namespace",
      }),
    },
  ]);
  expect((await presets(backend)).presets.get(PODS)).toEqual({
    columns: {},
    widths: {},
    group: "Namespace",
  });
});
