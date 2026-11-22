import { cleanup, render, screen } from "@testing-library/react";
import { CircleAlert } from "lucide-react";
import { afterEach, expect, test } from "vitest";
import { ErrorBanner } from "./ErrorBanner";

afterEach(cleanup);

test("a banner says its code on a line under the message, which the cut line does not hold", () => {
  const { container } = render(
    <ErrorBanner
      tone="error"
      icon={CircleAlert}
      title="Twigo hit an internal error."
      error={{ code: "internal.panic", message: "worker 3 panicked" }}
      message="This shell stopped."
    >
      Reopen it.
    </ErrorBanner>,
  );
  const cut = container.querySelector(".truncate");
  expect(cut?.textContent).toBe(
    "Twigo hit an internal error. This shell stopped. Reopen it.",
  );
  const code = container.querySelector("code");
  expect(code?.textContent).toBe("internal.panic");
  expect(cut?.contains(code ?? null)).toBe(false);
  expect(
    cut?.contains(screen.getByRole("button", { name: "Copy details" })),
  ).toBe(false);
});
