import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { Backend } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { Toaster } from "@twigo/ui";
import { nativeMenus } from "../commands/nativeMenu";
import { inWorkbench, testWorkbench } from "../testing";
import { QuickAccessWidget } from "../quickaccess/QuickAccessWidget";
import { REPORT_PROBLEM, REVEAL_LOG_FILE, SET_LOG_LEVEL } from "./commands";

afterEach(cleanup);

async function recording() {
  const mock = createMockBackend("ready");
  const calls: [string, unknown][] = [];
  const backend: Backend = {
    invoke: (command, request) => {
      calls.push([command, request]);
      return mock.invoke(command, request);
    },
    subscribe: (command, request, onMessage) =>
      mock.subscribe(command, request, onMessage),
  };
  return { workbench: await testWorkbench("ready", backend), calls };
}

test("Help lists the report, the log file and the log level after Quick Access Help, and the palette has them in Help", async () => {
  const { workbench } = await recording();
  const help = nativeMenus(workbench).find(({ title }) => title === "Help");
  expect(help?.groups.map((group) => group.map(({ title }) => title))).toEqual([
    ["Quick Access Help"],
    ["Report a Problem…", "Reveal Log File", "Set Log Level…"],
  ]);
  for (const id of [REPORT_PROBLEM, REVEAL_LOG_FILE, SET_LOG_LEVEL]) {
    expect(workbench.commands.get(id)?.category).toBe("Help");
  }
});

test("Set Log Level… offers Info, Debug and Trace, says that the choice lasts until Twigo quits, and sends the one picked", async () => {
  const { workbench, calls } = await recording();
  render(
    <>
      <QuickAccessWidget />
      <Toaster />
    </>,
    { wrapper: inWorkbench(workbench) },
  );
  let done: Promise<unknown> | undefined;
  await act(async () => {
    done = workbench.commands.execute(
      SET_LOG_LEVEL,
      workbench.keys.lookup(null),
    );
    await Promise.resolve();
  });
  expect(
    screen.getByPlaceholderText("Set the log level until Twigo quits"),
  ).toBeTruthy();
  expect(
    screen.getAllByRole("option").map((option) => option.textContent),
  ).toEqual([
    expect.stringContaining("Info"),
    expect.stringContaining("Debug"),
    expect.stringContaining("Trace"),
  ]);
  await act(async () => {
    screen.getByRole("option", { name: /Debug/ }).click();
    await done;
  });
  expect(calls).toContainEqual(["log_level_set", { level: "debug" }]);
  expect(
    await screen.findByText("Twigo logs at debug until it quits."),
  ).toBeTruthy();
});
