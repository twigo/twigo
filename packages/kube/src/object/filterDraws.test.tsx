import type { ComponentProps } from "react";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  mountKube,
  openList,
  settle,
  withScreenSize,
} from "../../test/workbench";

const content = vi.hoisted(() => ({ drawn: 0 }));

vi.mock("./ObjectContent", async (original) => {
  const real = await original<typeof import("./ObjectContent")>();
  return {
    ...real,
    ObjectContent: (props: ComponentProps<typeof real.ObjectContent>) => {
      content.drawn++;
      return <real.ObjectContent {...props} />;
    },
  };
});

vi.mock("../edit/YamlEditor", () => ({ default: () => <div /> }));

withScreenSize(1280);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const slash = (target: Element) => {
  fireEvent.keyDown(target, { code: "Slash", key: "/" });
};

async function typeInto(field: HTMLElement) {
  const type = (text: string) => {
    fireEvent.change(field, { target: { value: text } });
    return content.drawn;
  };
  const first = type("u");
  expect(type("ui")).toBe(first);
  expect(type("uid")).toBe(first);
  expect(type("")).toBeGreaterThan(first);
  await settle(1);
}

test("typing in the filter of the details draws the details again only when the text comes or goes", async () => {
  await openList();
  const [first] = screen.getAllByRole("row").slice(1);
  if (!first) throw new Error("no rows");
  fireEvent.click(first);
  await settle();
  const inspector = screen.getByRole("complementary", { name: "Pod details" });
  const panel = within(inspector).getByRole("tabpanel", { name: "Overview" });
  act(() => {
    panel.focus();
  });
  slash(panel);
  await settle(1);
  await typeInto(
    within(inspector).getByRole("textbox", { name: "Filter this page" }),
  );
});

test("typing in the filter of an object's editor draws the editor again only when the text comes or goes", async () => {
  const workbench = await mountKube();
  act(() => {
    workbench.editors.open(
      "k8s://prod-eu//v1/pods/auth/auth-api-1a4uyl1-r2bkk",
    );
  });
  await settle();
  slash(document.activeElement ?? document.body);
  await settle(2);
  await typeInto(screen.getByRole("textbox", { name: "Filter this page" }));
});
