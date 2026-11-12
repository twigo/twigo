import { afterEach, expect, test, vi } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { testWorkbench } from "@twigo/workbench/testing";
import { tellBind } from "./busy";

afterEach(() => {
  history.replaceState(null, "", "/");
});

async function asked(local: number, why: "inUse" | "notPermitted") {
  history.replaceState(null, "", "/?variant=busy:input");
  const workbench = await testWorkbench("live", createMockBackend("live"));
  void tellBind(
    workbench,
    { outcome: "busy", local, why, free: local + 1 },
    "web:http",
    () => Promise.reject(new Error("nothing asks again")),
    vi.fn(),
  );
  const prompt = workbench.quickAccess.session?.ask?.prompt;
  workbench.quickAccess.hide();
  return prompt;
}

test("a port below 1024 that the system does not let Twigo bind says why, and one above it says only that", async () => {
  expect(await asked(80, "notPermitted")).toBe(
    "Twigo cannot listen on 80: ports below 1024 need privileges it does not have. Enter forwards web:http on the port above.",
  );
  expect(await asked(1023, "notPermitted")).toContain(
    "ports below 1024 need privileges",
  );
  expect(await asked(1024, "notPermitted")).toBe(
    "Twigo cannot listen on 1024: the system does not let it bind that port. Enter forwards web:http on the port above.",
  );
  expect(await asked(8000, "notPermitted")).not.toContain("privileges");
});

test("a port in use says so, whatever the number", async () => {
  expect(await asked(80, "inUse")).toBe(
    "80 is in use by another process or forward. Enter forwards web:http on the port above.",
  );
});
