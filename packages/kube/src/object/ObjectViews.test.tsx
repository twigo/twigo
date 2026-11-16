import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openList, settle, withScreenSize } from "../../test/workbench";
import { OBJECT_TABS } from "./tabs";

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

const VIEWS = { name: "Views of the object" };
const titles = (list: HTMLElement) =>
  within(list)
    .getAllByRole("tab")
    .map((tab) => tab.textContent.replace(/\d+$/, ""));

test("the details and an editor show the same views, in a row above the object's content", async () => {
  await openList();
  const [first] = screen.getAllByRole("row").slice(1);
  if (!first) throw new Error("no rows");
  fireEvent.click(first);
  await settle();
  const inspector = within(
    screen.getByRole("complementary", { name: "Pod details" }),
  ).getByRole("tablist", VIEWS);
  expect(titles(inspector)).toEqual(OBJECT_TABS.map(({ title }) => title));

  fireEvent.click(screen.getByRole("button", { name: "Open in an editor" }));
  await settle();
  const editor = screen
    .getAllByRole("tablist", VIEWS)
    .find((list) => !list.closest("aside"));
  if (!editor) throw new Error("no views in the editor");
  expect(titles(editor)).toEqual(titles(inspector));
  const panel = screen
    .getAllByRole("tabpanel", { name: "Overview" })
    .find((each) => !each.closest("aside"));
  expect(
    editor.compareDocumentPosition(panel ?? document.body) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  act(() => {
    within(editor).getByRole("tab", { name: "Related" }).click();
  });
  await settle();
  expect(
    within(editor).getByRole("tab", { name: "Related" }).ariaSelected,
  ).toBe("true");
  expect(
    screen
      .getAllByRole("tabpanel", { name: "Related" })
      .some((each) => !each.closest("aside")),
  ).toBe(true);
});
