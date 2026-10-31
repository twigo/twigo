import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { Workbench } from "./Workbench";

test("the title bar drags the window", () => {
  const { container } = render(<Workbench />);
  expect(
    container.querySelector("header[data-tauri-drag-region]"),
  ).not.toBeNull();
});
