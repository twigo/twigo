import { afterEach, expect, test, vi } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { notify } from "@twigo/ui";
import { testWorkbench } from "@twigo/workbench/testing";
import { tellBind } from "./busy";

afterEach(() => {
  vi.restoreAllMocks();
});

async function told(local: number, why: "inUse" | "notPermitted") {
  const warning = vi.spyOn(notify, "warning");
  const workbench = await testWorkbench("live", createMockBackend("live"));
  const again = vi.fn();
  tellBind(
    workbench,
    { outcome: "busy", local, why, free: local + 1 },
    "web:http",
    again,
    vi.fn(),
  );
  expect(again).not.toHaveBeenCalled();
  return warning.mock.lastCall?.[0];
}

test("a port below 1024 that the system does not let Twigo bind says why, and one above it says only that", async () => {
  expect(await told(80, "notPermitted")).toBe(
    "Twigo cannot listen on 80: ports below 1024 need privileges it does not have, so web:http is not forwarded.",
  );
  expect(await told(1023, "notPermitted")).toContain(
    "ports below 1024 need privileges",
  );
  expect(await told(1024, "notPermitted")).toBe(
    "Twigo cannot listen on 1024: the system does not let it bind that port, so web:http is not forwarded.",
  );
  expect(await told(8000, "notPermitted")).not.toContain("privileges");
});

test("a port in use says so, whatever the number", async () => {
  expect(await told(80, "inUse")).toBe(
    "80 is in use by another process or forward, so web:http is not forwarded.",
  );
  expect(await told(8080, "inUse")).toBe(
    "8080 is in use by another process or forward, so web:http is not forwarded.",
  );
});

test("a busy answer asks nothing again until the button for the free port is pressed", async () => {
  const warning = vi.spyOn(notify, "warning");
  const workbench = await testWorkbench("live", createMockBackend("live"));
  const again = vi.fn().mockResolvedValueOnce({
    outcome: "busy",
    local: 8081,
    why: "inUse",
    free: 8082,
  });
  const done = vi.fn();
  tellBind(
    workbench,
    { outcome: "busy", local: 8080, why: "inUse", free: 8081 },
    "web:http",
    again,
    done,
  );
  expect(again).not.toHaveBeenCalled();
  expect(done).not.toHaveBeenCalled();
  const action = warning.mock.lastCall?.[1]?.action;
  expect(action?.label).toBe("Use 8081");
  action?.run();
  await vi.waitFor(() => {
    expect(again).toHaveBeenCalledExactlyOnceWith(8081);
  });
  expect(done).not.toHaveBeenCalled();
});
