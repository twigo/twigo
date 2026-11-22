import { act } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
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
