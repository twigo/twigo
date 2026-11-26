import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { StatusLabel } from "./status-label";

afterEach(cleanup);

const root = (container: HTMLElement) => container.firstElementChild?.className;

test("a status word takes its tone's colour, and the caller's classes win over its own", () => {
  const word = (tone: "error" | "warn" | "ok" | "idle", className?: string) =>
    root(
      render(
        <StatusLabel tone={tone} {...(className && { className })}>
          Running
        </StatusLabel>,
      ).container,
    );
  expect(word("error")).toBe(
    "inline-flex min-w-0 items-center gap-1.5 text-error",
  );
  expect(word("warn")).toBe(
    "inline-flex min-w-0 items-center gap-1.5 text-warn-foreground",
  );
  expect(word("ok")).toBe("inline-flex min-w-0 items-center gap-1.5");
  expect(word("idle")).toBe("inline-flex min-w-0 items-center gap-1.5");
  expect(word("error", "max-w-full gap-3")).toBe(
    "inline-flex min-w-0 items-center text-error max-w-full gap-3",
  );
});
