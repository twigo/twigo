import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { Space } from "@twigo/protocol";
import { Workbench } from "./Workbench";

const SPACES: Space[] = [
  { id: "prod", name: "prod", contexts: [{ name: "prod", color: "red" }] },
  { id: "dev", name: "dev", contexts: [{ name: "dev", color: null }] },
  {
    id: "dev+qa",
    name: "dev+qa",
    contexts: [
      { name: "dev", color: "green" },
      { name: "qa", color: "blue" },
    ],
  },
];

afterEach(cleanup);

function renderWorkbench() {
  return render(
    <Workbench spaces={SPACES} active="prod" onSelectSpace={() => undefined} />,
  );
}

test("the title bar drags the window", () => {
  const { container } = renderWorkbench();
  expect(
    container.querySelector("header[data-tauri-drag-region]"),
  ).not.toBeNull();
});

test("only a single-context space with a colour shows a dot", () => {
  renderWorkbench();
  const dots = (name: string) =>
    [...screen.getByRole("tab", { name }).querySelectorAll("[data-color]")].map(
      (dot) => dot.getAttribute("data-color"),
    );
  expect(dots("prod")).toEqual(["red"]);
  expect(dots("dev")).toEqual([]);
  expect(dots("dev+qa")).toEqual([]);
});
