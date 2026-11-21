import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { inWorkbench, testWorkbench } from "../testing";
import { TitleBar } from "./TitleBar";

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
});

test("the whole list stays in the crumb, and in the copy that decides the stages, where the variant asks for it", async () => {
  history.replaceState(null, "", "/?variant=crumb:list");
  const workbench = await testWorkbench();
  const { container } = render(<TitleBar />, {
    wrapper: inWorkbench(workbench),
  });
  act(() => {
    workbench.spaces.update("prod-eu", (state) => ({
      ...state,
      namespaces: ["auth", "checkout", "payments"],
    }));
  });
  expect(
    screen.getByRole("button", { name: "Select namespace, auth and 2 more" })
      .textContent,
  ).toBe("auth, checkout, payments");
  expect(container.querySelector('[data-copy="words"]')?.textContent).toContain(
    "auth, checkout, payments",
  );
});
