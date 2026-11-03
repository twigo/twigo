import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { inWorkbench, testWorkbench } from "../testing";
import { StatusEntries } from "./StatusBar";
import { useSpaceEntries } from "./StatusItems";

afterEach(cleanup);

test("the space entry names the active space's context, is filled with its colour, and opens the space picker", async () => {
  const workbench = await testWorkbench();
  render(<StatusEntries useEntries={useSpaceEntries} />, {
    wrapper: inWorkbench(workbench),
  });
  const entry = () => screen.getByTitle("Switch space");
  const filled = (color: string) =>
    entry().classList.contains(`bg-context-${color}-solid`);
  expect(entry().textContent).toBe("prod-eu");
  expect(filled("red")).toBe(true);

  await act(() => workbench.spaces.open("qa"));
  expect(entry().textContent).toBe("qa");
  expect(workbench.colors.source("qa")).toBe("automatic");
  expect(filled(workbench.colors.of("qa"))).toBe(true);
  act(() => {
    workbench.colors.choose("qa", "yellow");
  });
  expect(filled("yellow")).toBe(true);

  fireEvent.click(entry());
  expect(workbench.quickAccess.session?.value).toBe("ctx ");
});
