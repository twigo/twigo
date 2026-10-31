import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "./button";

describe("Button", () => {
  it("renders its children", () => {
    render(<Button>Click me</Button>);
    expect(
      screen.getByRole("button", { name: "Click me" }),
    ).toBeInTheDocument();
  });

  it("applies the brand variant", () => {
    render(<Button variant="brand">Go</Button>);
    expect(screen.getByRole("button", { name: "Go" })).toHaveClass("bg-brand");
  });
});
