import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { inWorkbench, testWorkbench } from "../testing";
import { StatusBar, StatusEntries } from "./StatusBar";
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

const settled = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );

test("the space entry has a lock while its mode holds writes back, open during an unlock", async () => {
  const workbench = await testWorkbench();
  render(<StatusEntries useEntries={useSpaceEntries} />, {
    wrapper: inWorkbench(workbench),
  });
  await settled();
  const icon = () => screen.getByTitle("Switch space").querySelector("svg");
  expect(icon()?.classList.contains("lucide-lock")).toBe(true);

  await act(() => workbench.backend.invoke("context_unlock", "prod-eu"));
  expect(icon()?.classList.contains("lucide-lock-open")).toBe(true);

  act(() => {
    workbench.spaces.select("dev");
  });
  expect(icon()).toBeNull();
});

test("the bar is tinted for Production, and for no other context", async () => {
  const workbench = await testWorkbench();
  const { container } = render(<StatusBar />, {
    wrapper: inWorkbench(workbench),
  });
  await settled();
  const footer = () => container.querySelector("footer");
  expect(footer()?.dataset.strong).toBe("");
  expect(footer()?.style.getPropertyValue("--twigo-context")).toBe(
    "var(--context-red)",
  );
  act(() => {
    workbench.spaces.select("staging");
  });
  expect(footer()?.dataset.strong).toBeUndefined();
});
