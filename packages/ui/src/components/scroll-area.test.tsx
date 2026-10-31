import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ScrollArea } from "./scroll-area";

afterEach(cleanup);

describe("ScrollArea", () => {
  it("renders its content inside the viewport", () => {
    render(
      <ScrollArea className="h-10">
        <p>scrollable body</p>
      </ScrollArea>,
    );
    expect(screen.getByText("scrollable body")).toBeInTheDocument();
  });
});
