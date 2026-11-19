import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { PropertyList } from "./property-list";

afterEach(cleanup);

test("a row has a copy icon only when it has something to copy, named for its label", () => {
  render(
    <PropertyList
      items={[
        { key: "a", label: "Image", value: "nginx", copy: "nginx" },
        { key: "b", label: "Ports", value: "–" },
      ]}
    />,
  );
  expect(
    screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual(["Copy value of Image"]);
});

test("a stacked row's label takes a line to itself over its value, and its copy icon ends that line", () => {
  render(
    <PropertyList
      items={[
        {
          key: "a",
          label: "Image",
          value: "docker.io/kindest/local-path-helper:v20260131-7181c60a",
          stacked: true,
          copy: "docker.io/kindest/local-path-helper:v20260131-7181c60a",
        },
        { key: "b", label: "Phase", value: "Running" },
      ]}
    />,
  );
  const [stackedLabel, besideLabel] = screen.getAllByRole("term");
  if (!stackedLabel || !besideLabel) throw new Error("two labels");
  expect(stackedLabel.className).toContain("col-span-2");
  expect(besideLabel.className).not.toContain("col-span-2");
  expect(
    within(stackedLabel).getByRole("button", {
      name: "Copy value of Image",
    }),
  ).toBeTruthy();
});

test("a cut value's copy icon follows it in its cell, to lie over its end, and is one element", () => {
  render(
    <PropertyList
      items={[
        {
          key: "a",
          label: "Node",
          value: <a href="#node">twigo-control-plane</a>,
          copy: "twigo-control-plane",
        },
      ]}
    />,
  );
  const cell = screen.getByRole("definition");
  expect([...cell.children].map((child) => child.tagName)).toEqual([
    "A",
    "BUTTON",
  ]);
  expect(within(cell).getByRole("button").childElementCount).toBe(0);
});

test("a wrapping value's copy icon comes first in its cell, so that it floats at the end of the first line and covers none of the value", () => {
  render(
    <PropertyList
      items={[
        {
          key: "a",
          label: "/var/run/secrets",
          value: <span>kube-api-access-szhp5 (ro)</span>,
          wraps: true,
          copy: "kube-api-access-szhp5 (ro)",
        },
      ]}
    />,
  );
  const cell = screen.getByRole("definition");
  expect([...cell.children].map((child) => child.tagName)).toEqual([
    "BUTTON",
    "SPAN",
  ]);
});
