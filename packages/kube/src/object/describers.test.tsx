import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { Overview as Document } from "@twigo/protocol";
import { inWorkbench, testWorkbench } from "@twigo/workbench/testing";
import OBJECTS from "../../../protocol/src/mock/objects.json";
import { Overview } from "./Overview";

afterEach(() => {
  cleanup();
});

const RECORDED = OBJECTS as unknown as Readonly<
  Record<string, { overview: Document }>
>;

async function shown(name: string) {
  const overview = RECORDED[name]?.overview;
  if (!overview) throw new Error(`no recorded ${name}`);
  const workbench = await testWorkbench("ready");
  render(
    <Overview overview={overview} space="prod-eu" onOpen={() => undefined} />,
    { wrapper: inWorkbench(workbench) },
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return overview;
}

function section(title: string): HTMLElement {
  return screen.getByRole("region", { name: title });
}

test.each(Object.keys(RECORDED))(
  "the recorded %s renders every section its document holds",
  async (name) => {
    const overview = await shown(name);
    for (const { title, blocks } of overview.sections) {
      const region = section(title);
      for (const block of blocks) {
        if (block.type === "table")
          expect(
            within(region).getByRole("table", { name: title }),
          ).toBeDefined();
        if (block.type === "diagnostics")
          for (const finding of block.findings)
            expect(within(region).getByText(finding.title)).toBeDefined();
        if (block.type === "containers")
          for (const container of block.containers)
            expect(
              within(region).getAllByText(container.name).length,
            ).toBeGreaterThan(0);
        if (block.type === "list")
          expect(
            within(region).queryByRole("grid") ??
              within(region).queryByText(`No ${block.gvr.resource}`),
          ).not.toBeNull();
      }
    }
  },
);

test("a crashing pod says why first, and its container's card folds its details", async () => {
  await shown("pod-crashing");
  const regions = screen.getAllByRole("region");
  expect(regions[0]?.getAttribute("aria-label")).toBe("Diagnostics");
  const alert = within(section("Diagnostics")).getByRole("alert");
  expect(alert.textContent).toContain("Container api keeps crashing");
  expect(alert.textContent).toMatch(/Exited with code 1, \d+ restarts, last /);
  expect(alert.textContent).toContain(
    "panic: dial tcp 10.96.0.20:5432: connect: connection refused",
  );
  const containers = section("Containers");
  expect(
    within(containers).getByText("Waiting · CrashLoopBackOff"),
  ).toBeDefined();
  expect(within(containers).getByText("Last state")).toBeDefined();
  expect(within(containers).queryByText("Command")).toBeNull();
  expect(
    within(containers).getByRole("button", { name: /^Details \d+$/ }),
  ).toBeDefined();
});

test("a node adds up its pods' requests in its resources table", async () => {
  await shown("node");
  const resources = within(section("Resources")).getByRole("table", {
    name: "Resources",
  });
  const cpu = within(resources).getByText("970m (6%)");
  expect(cpu.closest("tr")?.textContent).toContain("cpu");
});

test("a claim links the pod that uses it, and a Service its endpoints", async () => {
  await shown("pvc");
  expect(
    within(section("Claim")).getByRole("button", { name: "db-0" }),
  ).toBeDefined();
  cleanup();
  await shown("service");
  const ports = within(section("Ports")).getByRole("table", { name: "Ports" });
  expect(ports.textContent).toMatch(
    /10\.244\.\d+\.\d+:8080, 10\.244\.\d+\.\d+:8080/,
  );
});
