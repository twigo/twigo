import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Tooltip, TooltipTrigger, TooltipContent } from "./tooltip";
import { Button } from "./button";

afterEach(cleanup);

describe("Tooltip", () => {
  it("renders its trigger (content is portalled on hover)", () => {
    render(
      <Tooltip>
        <TooltipTrigger>hover me</TooltipTrigger>
        <TooltipContent>helpful tip</TooltipContent>
      </Tooltip>,
    );
    expect(
      screen.getByRole("button", { name: "hover me" }),
    ).toBeInTheDocument();
  });

  it("Button's tooltip prop keeps the button rendering", () => {
    render(
      <Button tooltip="Save the file" aria-label="Save">
        Go
      </Button>,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("draws above the toaster, so a toast cannot hide it", () => {
    const sonner = readFileSync(
      join(import.meta.dirname, "../../node_modules/sonner/dist/styles.css"),
      "utf8",
    );
    const toaster = Number(
      /\n\[data-sonner-toaster\] \{[^}]*?z-index: (\d+)/.exec(sonner)?.[1],
    );
    render(
      <Tooltip open>
        <TooltipTrigger>hover me</TooltipTrigger>
        <TooltipContent>helpful tip</TooltipContent>
      </Tooltip>,
    );
    const content = document.querySelector('[data-slot="tooltip-content"]');
    const tooltip = Number(/z-\[(\d+)\]/.exec(content?.className ?? "")?.[1]);
    expect(toaster).toBeGreaterThan(0);
    expect(tooltip).toBeGreaterThan(toaster);
  });
});
