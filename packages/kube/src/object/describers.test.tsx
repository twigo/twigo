import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { Overview as Document } from "@twigo/protocol";
import { inWorkbench, testWorkbench } from "@twigo/workbench/testing";
import OBJECTS from "../../../protocol/src/mock/objects.json";
import { Overview } from "./Overview";
import { OverviewStates } from "./overviewStates";

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
    <Overview
      overview={overview}
      space="prod-eu"
      states={new OverviewStates()}
      kind="/pods"
      onOpen={() => undefined}
    />,
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
  const alert = section("Diagnostics");
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

test("a finding that comes or goes is announced once, and its tone has a name", async () => {
  const crashing = RECORDED["pod-crashing"]?.overview;
  const healthy = RECORDED.pod?.overview;
  if (!crashing || !healthy) throw new Error("the pods");
  const workbench = await testWorkbench("ready");
  const view = (overview: Document) => (
    <Overview
      overview={overview}
      space="prod-eu"
      states={new OverviewStates()}
      kind="/pods"
      onOpen={() => undefined}
    />
  );
  const { rerender } = render(view(crashing), {
    wrapper: inWorkbench(workbench),
  });
  const live = () => document.querySelector("[aria-live=polite]")?.textContent;
  expect(live()).toBe("");
  expect(
    within(section("Diagnostics")).getByRole("img", { name: "Error" }),
  ).toBeDefined();
  rerender(view(healthy));
  expect(live()).toBe("Resolved: Container api keeps crashing");
  rerender(view(crashing));
  expect(live()).toBe("Container api keeps crashing");
});

test("a container's folds stay open for the kind's next object", async () => {
  const states = new OverviewStates();
  const overview = RECORDED["pod-crashing"]?.overview;
  if (!overview) throw new Error("the crashing pod");
  const workbench = await testWorkbench("ready");
  const mounted = (kind: string) =>
    render(
      <Overview
        overview={overview}
        space="prod-eu"
        states={states}
        kind={kind}
        onOpen={() => undefined}
      />,
      { wrapper: inWorkbench(workbench) },
    );
  mounted("/pods");
  const details = () =>
    within(section("Containers")).getByRole("button", {
      name: /^Details \d+$/,
    });
  expect(details().getAttribute("aria-expanded")).toBe("false");
  act(() => {
    details().click();
  });
  expect(details().getAttribute("aria-expanded")).toBe("true");
  cleanup();
  mounted("/pods");
  expect(details().getAttribute("aria-expanded")).toBe("true");
  cleanup();
  mounted("/other");
  expect(details().getAttribute("aria-expanded")).toBe("false");
});

test("a node's condition tells its last heartbeat in its tooltip", async () => {
  const node = RECORDED.node?.overview;
  if (!node) throw new Error("the node");
  const beating: Document = {
    sections: node.sections.map((section) => ({
      ...section,
      blocks: section.blocks.map((block) =>
        block.type === "conditions"
          ? {
              ...block,
              conditions: block.conditions.map((condition) => ({
                ...condition,
                lastHeartbeat: "2026-11-03T10:00:00Z",
              })),
            }
          : block,
      ),
    })),
  };
  const workbench = await testWorkbench("ready");
  render(
    <Overview
      overview={beating}
      space="prod-eu"
      states={new OverviewStates()}
      kind="/nodes"
      onOpen={() => undefined}
    />,
    { wrapper: inWorkbench(workbench) },
  );
  const ready = within(section("Conditions")).getByText("Ready").closest("li");
  expect(ready?.getAttribute("title")).toContain(
    `Last heartbeat ${new Date("2026-11-03T10:00:00Z").toLocaleString()}`,
  );
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
