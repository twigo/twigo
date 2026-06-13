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
});
