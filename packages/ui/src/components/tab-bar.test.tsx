import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { resize } from "../../test/resize";
import { TabBar, type Tab } from "./tab-bar";

afterEach(cleanup);

type View = "overview" | "yaml" | "events" | "related";

const TABS: readonly Tab<View>[] = [
  { value: "overview", label: "Overview" },
  { value: "yaml", label: "YAML" },
  { value: "events", label: "Events", count: 2, warn: true },
  { value: "related", label: "Related", count: 14 },
];

function Views({ first = "overview" }: { first?: View }) {
  const [value, setValue] = useState<View>(first);
  return (
    <TabBar
      label="Views of the object"
      tabs={TABS}
      value={value}
      onChange={setValue}
    />
  );
}

const tab = (name: string) =>
  screen.getByRole("tab", { name: new RegExp(`^${name}`) });
const order = () => screen.getAllByRole("tab").map((each) => each.tabIndex);
const shown = () =>
  screen
    .getAllByRole("tab")
    .filter((each) => each.getAttribute("aria-selected") === "true")
    .map((each) => each.textContent);
const names = () =>
  screen
    .getAllByRole("tab")
    .map((each) => each.textContent.replace(/\d+$/, ""));
const more = () => screen.queryByRole("button", { name: /^More/ });
const press = (key: string) => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key });
};

test("the shown tab is selected and the only one Tab reaches, a click shows another, and a count follows its label", () => {
  render(<Views />);
  expect(
    screen.getByRole("tablist", { name: "Views of the object" }),
  ).toBeTruthy();
  expect(shown()).toEqual(["Overview"]);
  expect(order()).toEqual([0, -1, -1, -1]);
  fireEvent.click(tab("YAML"));
  expect(shown()).toEqual(["YAML"]);
  expect(order()).toEqual([-1, 0, -1, -1]);
  expect(tab("Events").textContent).toBe("Events2");
  expect(tab("Related").textContent).toBe("Related14");
});

test("a warning count carries a mark that says it, so that the tone is not the only cue", () => {
  render(<Views />);
  expect(
    within(tab("Events")).getByRole("img", { name: "Warnings" }),
  ).toBeTruthy();
  expect(within(tab("Related")).queryByRole("img")).toBeNull();
});

test("the arrows show the next or the previous tab, round the ends, Home and End the first and the last, and the focus follows", () => {
  render(<Views />);
  tab("Overview").focus();
  press("ArrowLeft");
  expect(shown()).toEqual(["Related14"]);
  expect(document.activeElement).toBe(tab("Related"));
  press("ArrowRight");
  expect(shown()).toEqual(["Overview"]);
  press("ArrowRight");
  expect(shown()).toEqual(["YAML"]);
  expect(document.activeElement).toBe(tab("YAML"));
  press("End");
  expect(shown()).toEqual(["Related14"]);
  press("Home");
  expect(shown()).toEqual(["Overview"]);
  expect(document.activeElement).toBe(tab("Overview"));
});

function layOut(width: number, needs: readonly number[]) {
  const sized = (element: Element, value: number) => {
    Object.defineProperty(element, "clientWidth", {
      configurable: true,
      value,
    });
  };
  const row = screen.getByRole("tablist").parentElement;
  if (!row) throw new Error("no row");
  sized(row, width);
  for (const copy of document.querySelectorAll("[data-stage]"))
    sized(copy, needs[Number(copy.getAttribute("data-stage"))] ?? 0);
  act(() => {
    resize();
  });
}

const NEEDS = [300, 250, 200, 150];

test("as the row narrows the last tabs fold into More, and a tab comes back only with 16 px to spare", () => {
  render(<Views />);
  expect(more()).toBeNull();
  layOut(320, NEEDS);
  expect(names()).toEqual(["Overview", "YAML", "Events", "Related"]);
  expect(more()).toBeNull();
  layOut(299, NEEDS);
  expect(names()).toEqual(["Overview", "YAML", "Events"]);
  expect(more()).not.toBeNull();
  layOut(315, NEEDS);
  expect(names()).toEqual(["Overview", "YAML", "Events"]);
  layOut(316, NEEDS);
  expect(names()).toEqual(["Overview", "YAML", "Events", "Related"]);
  expect(more()).toBeNull();
  layOut(249, NEEDS);
  expect(names()).toEqual(["Overview", "YAML"]);
  layOut(150, NEEDS);
  expect(names()).toEqual(["Overview"]);
  layOut(215, NEEDS);
  expect(names()).toEqual(["Overview"]);
  layOut(216, NEEDS);
  expect(names()).toEqual(["Overview", "YAML"]);
  layOut(400, NEEDS);
  expect(names()).toEqual(["Overview", "YAML", "Events", "Related"]);
});

test("a fold that takes more room than the one before it, because More is wider than the one tab it holds, is skipped", () => {
  render(<Views />);
  const needs = [277, 282, 212, 159];
  layOut(280, needs);
  expect(names()).toEqual(["Overview", "YAML", "Events", "Related"]);
  layOut(276, needs);
  expect(names()).toEqual(["Overview", "YAML"]);
  layOut(292, needs);
  expect(names()).toEqual(["Overview", "YAML"]);
  layOut(293, needs);
  expect(names()).toEqual(["Overview", "YAML", "Events", "Related"]);
});

test("More opens the folded tabs as a menu, with their counts, and the one it picks shows and takes its place among the others", () => {
  render(<Views />);
  layOut(240, NEEDS);
  expect(names()).toEqual(["Overview", "YAML"]);
  fireEvent.pointerDown(more() ?? document.body, {
    button: 0,
    ctrlKey: false,
  });
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual(["Events2", "Related14"]);
  fireEvent.click(screen.getByRole("menuitem", { name: /^Related/ }));
  expect(shown()).toEqual(["Related14"]);
  expect(names()).toEqual(["Overview", "Related"]);
});

test("the shown tab never folds, though it is the last", () => {
  render(<Views first="related" />);
  layOut(240, NEEDS);
  expect(names()).toEqual(["Overview", "Related"]);
  expect(shown()).toEqual(["Related14"]);
  layOut(150, NEEDS);
  expect(names()).toEqual(["Related"]);
  fireEvent.pointerDown(more() ?? document.body, {
    button: 0,
    ctrlKey: false,
  });
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual(["Overview", "YAML", "Events2"]);
});

test("More says that a folded tab holds warnings, and only then", () => {
  render(<Views />);
  layOut(240, NEEDS);
  expect(more()?.getAttribute("aria-label")).toBe("More, with warnings");
  fireEvent.click(tab("YAML"));
  layOut(150, NEEDS);
  expect(more()?.getAttribute("aria-label")).toBe("More, with warnings");
  fireEvent.pointerDown(more() ?? document.body, {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(screen.getByRole("menuitem", { name: /^Events/ }));
  layOut(240, NEEDS);
  expect(more()?.getAttribute("aria-label")).toBe("More");
});

test("the arrows, Home and End move among the tabs that show, and the focus follows", () => {
  render(<Views />);
  layOut(240, NEEDS);
  tab("Overview").focus();
  press("End");
  expect(shown()).toEqual(["YAML"]);
  expect(document.activeElement).toBe(tab("YAML"));
  press("ArrowRight");
  expect(shown()).toEqual(["Overview"]);
  press("ArrowLeft");
  expect(shown()).toEqual(["YAML"]);
});
