import { vi } from "vitest";
import type { ApplyRequest, Backend } from "@twigo/protocol";
import { createMockBackend, type MockScenario } from "@twigo/protocol/mock";
import { testWorkbench } from "@twigo/workbench/testing";
import { Discovery } from "../src/discovery";
import { registerEdits } from "../src/edit/commands";
import { createEdits, editLookup } from "../src/edit/services";
import { ObjectTabs } from "../src/object/tabs";

export const base = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "settings", namespace: "default", resourceVersion: "7" },
  data: { a: "0" },
};
export const EDITED =
  "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: settings\n  namespace: default\ndata:\n  a: '1'\n";

export async function setupEdit(
  scenario: MockScenario,
  space = "dev",
  gate?: Promise<void>,
) {
  const real = createMockBackend(scenario);
  const sent: ApplyRequest[] = [];
  const backend: Backend = {
    invoke: async (command, request) => {
      if (command === "apply_preview") {
        sent.push(request as ApplyRequest);
        await gate;
      }
      return real.invoke(command, request);
    },
    subscribe: (command, request, onMessage) =>
      real.subscribe(command, request, onMessage),
  };
  const workbench = await testWorkbench(scenario, backend);
  workbench.spaces.select(space);
  const edits = createEdits(workbench);
  const discovery = new Discovery(workbench);
  registerEdits(workbench, { discovery, edits, tabs: new ObjectTabs() });
  const open = vi
    .spyOn(workbench.editors, "open")
    .mockImplementation(() => undefined);
  const close = vi
    .spyOn(workbench.editors, "close")
    .mockImplementation(() => undefined);
  const uri = `k8s://${space}//v1/configmaps/default/settings`;
  edits.copies.edit(uri, EDITED, {
    space,
    base: JSON.stringify(base),
    lock: "7",
  });
  edits.copies.see(uri, JSON.stringify(base), false);
  const run = (id: string) =>
    workbench.commands.execute(
      id,
      editLookup(edits, uri, workbench.keys.lookup(null)),
      { uri },
    );
  return { workbench, edits, discovery, sent, open, close, uri, run };
}
