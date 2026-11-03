import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { RelatedView } from "./ObjectContent";

afterEach(() => {
  cleanup();
});

test("owned objects that cannot be listed say why instead of none", () => {
  render(
    <RelatedView
      related={{
        owners: [],
        owned: [],
        unavailable: "You may not list pods.",
      }}
      onOpen={() => undefined}
    />,
  );
  const owns = screen.getByRole("region", { name: "Owns" });
  expect(owns.textContent).toContain("You may not list pods.");
  expect(within(owns).queryByText("None")).toBeNull();
});
