import { act } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Backend, Catalog } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { notify } from "@twigo/ui";
import { testWorkbench } from "./testing";

afterEach(() => {
  vi.restoreAllMocks();
});

test("toast:once, the default: each kubeconfig file that fails raises one warning, led by its name, with its code", async () => {
  const warning = vi.spyOn(notify, "warning");
  await testWorkbench("kubeconfigFailures");
  await act(() => Promise.resolve());
  expect(warning).toHaveBeenCalledTimes(2);
  const [node, options] = warning.mock.calls[0] ?? [];
  expect(options?.key).toBe("kubeconfig:~/.kube/broken.yaml");
  expect(node).toMatchObject({
    props: {
      lead: "~/.kube/broken.yaml: ",
      error: { code: "kubeconfig.unparsable" },
    },
  });
});

test("a start with no file that fails raises none", async () => {
  const warning = vi.spyOn(notify, "warning");
  await testWorkbench("live");
  expect(warning).not.toHaveBeenCalled();
});

test("a file that reads well again takes its warning away, and the one still failing keeps its own", async () => {
  const mock = createMockBackend("kubeconfigFailures");
  let send: ((next: Catalog) => void) | undefined;
  const backend: Backend = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe: (command, request, onMessage) => {
      if (command === "contexts_watch") {
        send = onMessage as (next: Catalog) => void;
      }
      return mock.subscribe(command, request, onMessage);
    },
  };
  const dismiss = vi.spyOn(notify, "dismiss");
  const workbench = await testWorkbench("kubeconfigFailures", backend);
  await act(() => Promise.resolve());
  const { list, failures } = workbench.catalog;
  const [fixed, broken] = failures;
  if (!list || !fixed || !broken)
    throw new Error("the scenario lost its files");

  act(() => {
    send?.({ contexts: [...list], failures: [broken] });
  });
  expect(dismiss.mock.calls).toEqual([[`kubeconfig:${fixed.source}`]]);
});
