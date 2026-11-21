import { afterEach, expect, test } from "vitest";
import { testWorkbench } from "@twigo/workbench/testing";
import { namespaceProvider } from "./quickaccess";

afterEach(() => {
  history.replaceState(null, "", "/");
});

test.each([
  [undefined, { checklist: false, live: false }],
  ["checklist", { checklist: true, live: false }],
  ["live", { checklist: false, live: true }],
])("the ns picker's variant %s", async (asked, flags) => {
  if (asked) history.replaceState(null, "", `/?variant=pick:${asked}`);
  const provider = namespaceProvider(await testWorkbench());
  expect({ checklist: provider.checklist, live: provider.live }).toEqual(flags);
});
