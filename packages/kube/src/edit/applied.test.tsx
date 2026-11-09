import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { APPLIED_LAG_MS, createMockBackend } from "@twigo/protocol/mock";
import { mountKube, settle, withScreenSize } from "../../test/workbench";

const yaml = vi.hoisted(() => ({
  texts: [] as string[],
  change: undefined as ((text: string) => void) | undefined,
}));

vi.mock("./YamlEditor", () => ({
  default: ({
    text,
    onChange,
  }: {
    text: string;
    onChange?: (text: string) => void;
  }) => {
    yaml.texts.push(text);
    yaml.change = onChange;
    return <pre data-testid="yaml">{text}</pre>;
  },
}));

vi.mock("./DiffView", () => ({ default: () => <div /> }));

withScreenSize(1200);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  yaml.texts.length = 0;
  vi.clearAllTimers();
  vi.useRealTimers();
});

const URI = "k8s://dev//v1/configmaps/default/settings";

test("an applied edit never shows the object as it was, though the object comes after the plan is done", async () => {
  const workbench = await mountKube(createMockBackend("applyLate"));
  act(() => {
    workbench.spaces.select("dev");
  });
  await settle(2);
  act(() => {
    workbench.editors.open(URI);
  });
  await settle();
  act(() => {
    within(screen.getByRole("group", { name: "Views of the object" }))
      .getByRole("button", { name: "YAML" })
      .click();
  });
  await settle();
  const old = screen.getByTestId("yaml").textContent;
  expect(old).toContain("mode: fast");
  if (!yaml.change) throw new Error("the editor was not shown");

  act(() => {
    yaml.change?.(old.replace("mode: fast", "mode: slow"));
  });
  const run = async (id: string) => {
    act(() => {
      void workbench.commands.execute(id, workbench.keys.lookup(null), {
        uri: URI,
      });
    });
    await settle();
  };
  await run("k8s.edit.apply");
  yaml.texts.length = 0;
  act(() => {
    screen.getByRole("button", { name: "Apply" }).click();
  });
  await settle();

  expect(screen.getByTestId("yaml").textContent).toContain("mode: slow");
  await act(() => vi.advanceTimersByTimeAsync(APPLIED_LAG_MS));
  await settle();
  const now = screen.getByTestId("yaml").textContent;
  expect(now).toContain("mode: slow");
  expect(now).not.toBe(old.replace("mode: fast", "mode: slow"));
  expect(yaml.texts.length).toBeGreaterThan(0);
  expect(yaml.texts.filter((text) => text.includes("mode: fast"))).toEqual([]);
});
