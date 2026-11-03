import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { TabBar, type Tab } from "./tab-bar";

afterEach(cleanup);

type View = "overview" | "yaml" | "events";

const TABS: readonly Tab<View>[] = [
  { value: "overview", label: "Overview" },
  { value: "yaml", label: "YAML" },
  { value: "events", label: "Events", count: 2, warn: true },
];

function Views() {
  const [value, setValue] = useState<View>("overview");
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

test("the shown tab is selected and the only one Tab reaches, a click shows another, and a count follows its label", () => {
  render(<Views />);
  expect(
    screen.getByRole("tablist", { name: "Views of the object" }),
  ).toBeTruthy();
  expect(shown()).toEqual(["Overview"]);
  expect(order()).toEqual([0, -1, -1]);
  fireEvent.click(tab("YAML"));
  expect(shown()).toEqual(["YAML"]);
  expect(order()).toEqual([-1, 0, -1]);
  expect(tab("Events").textContent).toBe("Events2");
});

test("the arrows show the next or the previous tab, round the ends, Home and End the first and the last, and the focus follows", () => {
  render(<Views />);
  const press = (key: string) => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key });
  };
  tab("Overview").focus();
  press("ArrowLeft");
  expect(shown()).toEqual(["Events2"]);
  expect(document.activeElement).toBe(tab("Events"));
  press("ArrowRight");
  expect(shown()).toEqual(["Overview"]);
  press("ArrowRight");
  expect(shown()).toEqual(["YAML"]);
  expect(document.activeElement).toBe(tab("YAML"));
  press("End");
  expect(shown()).toEqual(["Events2"]);
  press("Home");
  expect(shown()).toEqual(["Overview"]);
  expect(document.activeElement).toBe(tab("Overview"));
});
