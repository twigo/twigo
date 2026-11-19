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

test("`/` with the focus in the details opens a filter in the views row, which hides what does not match and says what did; the list keeps its own `/`", async () => {
  await openList();
  const [first] = screen.getAllByRole("row").slice(1);
  if (!first) throw new Error("no rows");
  fireEvent.click(first);
  await settle();
  const inspector = screen.getByRole("complementary", { name: "Pod details" });
  const panel = within(inspector).getByRole("tabpanel", { name: "Overview" });
  const slash = (target: Element) => {
    fireEvent.keyDown(target, { code: "Slash", key: "/" });
  };

  act(() => {
    screen.getByRole("grid").focus();
  });
  slash(screen.getByRole("grid"));
  await settle(1);
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "Filter rows" }),
  );
  expect(within(inspector).queryByRole("textbox")).toBeNull();

  act(() => {
    panel.focus();
  });
  slash(panel);
  await settle(1);
  const field = within(inspector).getByRole("textbox", {
    name: "Filter this page",
  });
  expect(field.getAttribute("placeholder")).toBe("Filter this Pod");
  expect(document.activeElement).toBe(field);
  const views = within(inspector).getByRole("tablist", VIEWS);
  expect(
    views.parentElement?.parentElement?.parentElement?.contains(field),
  ).toBe(true);

  fireEvent.change(field, { target: { value: "uid" } });
  await settle(1);
  expect(within(inspector).getByRole("status").textContent).toBe(
    "1 match in 1 section",
  );
  expect(within(panel).getByRole("region", { name: "Metadata" })).toBeTruthy();
  expect(
    within(panel).queryByRole("region", { name: "Conditions" }),
  ).toBeNull();

  fireEvent.keyDown(field, { key: "Enter" });
  await settle(1);
  expect(document.activeElement?.closest("[data-section]")).not.toBeNull();
  expect(document.activeElement?.getAttribute("aria-expanded")).toBe("true");

  slash(panel);
  await settle(1);
  expect(document.activeElement).toBe(field);
  fireEvent.keyDown(field, { key: "Escape" });
  expect(field.getAttribute("value")).toBe("");
  expect(
    within(panel).getByRole("region", { name: "Conditions" }),
  ).toBeTruthy();
  fireEvent.keyDown(field, { key: "Escape" });
  await settle(1);
  expect(
    within(inspector).queryByRole("textbox", { name: "Filter this page" }),
  ).toBeNull();
  expect(document.activeElement).toBe(panel);
});

test("Escape with the focus in the page clears the filter's text and returns to its field, before it closes the details", async () => {
  await openList();
  const [first] = screen.getAllByRole("row").slice(1);
  if (!first) throw new Error("no rows");
  fireEvent.click(first);
  await settle();
  const inspector = () =>
    screen.queryByRole("complementary", { name: "Pod details" });
  const panel = within(inspector() ?? document.body).getByRole("tabpanel", {
    name: "Overview",
  });
  const escape = () => {
    fireEvent.keyDown(document.activeElement ?? document.body, {
      code: "Escape",
      key: "Escape",
    });
  };
  act(() => {
    panel.focus();
  });
  fireEvent.keyDown(panel, { code: "Slash", key: "/" });
  await settle(1);
  const field = screen.getByRole("textbox", { name: "Filter this page" });
  fireEvent.change(field, { target: { value: "uid" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await settle(1);
  expect(panel.contains(document.activeElement)).toBe(true);

  escape();
  await settle(1);
  expect(field.getAttribute("value")).toBe("");
  expect(document.activeElement).toBe(field);
  expect(inspector()).not.toBeNull();

  escape();
  await settle(1);
  expect(document.activeElement).toBe(panel);
  expect(inspector()).not.toBeNull();

  escape();
  await settle(1);
  expect(inspector()).toBeNull();
});
