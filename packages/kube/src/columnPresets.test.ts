import { expect, test } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { StateStore } from "@twigo/workbench";
import { ColumnPresets } from "./columnPresets";
import { PODS } from "./kinds";

const KEY = "columns//pods";

async function presets(backend = createMockBackend("ready")) {
  const state = await StateStore.load(backend, () => undefined);
  return { presets: new ColumnPresets(state), state };
}

test("a choice joins the stored ones and comes back in the next window", async () => {
  const backend = createMockBackend("ready");
  await backend.invoke("state_set", [
    { space: null, key: KEY, value: JSON.stringify({ IP: true }) },
  ]);
  const first = await presets(backend);
  expect(first.presets.choices(PODS)).toEqual({ IP: true });
  first.presets.choose(PODS, "Node", true);
  expect(first.presets.choices(PODS)).toEqual({ IP: true, Node: true });

  await first.state.settled();
  const next = await presets(backend);
  expect(next.presets.choices(PODS)).toEqual({ IP: true, Node: true });
});

test("stored choices that are not column names and flags read as none", async () => {
  const backend = createMockBackend("ready");
  await backend.invoke("state_set", [
    { space: null, key: KEY, value: JSON.stringify({ IP: "yes" }) },
  ]);
  expect((await presets(backend)).presets.choices(PODS)).toEqual({});
});
