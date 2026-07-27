import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { InspectorSplit } from "./InspectorSplit";
import { clampInspectorWidth } from "./inspectorWidth";

afterEach(cleanup);

describe("clampInspectorWidth", () => {
  it("keeps a comfortable width untouched", () => {
    expect(clampInspectorWidth(380, 1200)).toBe(380);
  });

  it("never lets the inspector shrink past its minimum", () => {
    expect(clampInspectorWidth(40, 1200)).toBe(260);
  });

  it("never lets the inspector starve the table", () => {
    expect(clampInspectorWidth(1100, 1200)).toBe(880);
  });

  it("still yields the inspector minimum when the container cannot fit both", () => {
    expect(clampInspectorWidth(400, 400)).toBe(260);
  });

  it("rounds to whole pixels so a drag cannot accumulate fractions", () => {
    expect(clampInspectorWidth(380.4, 1200)).toBe(380);
  });

  it("keeps the requested width when the container has no measurable size", () => {
    expect(clampInspectorWidth(404, 0)).toBe(404);
  });
});

describe("InspectorSplit", () => {
  function setup(visible = true) {
    return render(
      <InspectorSplit
        inspectorVisible={visible}
        defaultWidth={380}
        main={<div>table</div>}
        inspector={<div>inspector</div>}
      />,
    );
  }

  it("renders the inspector at its default width", () => {
    setup();
    expect(screen.getByText("inspector").parentElement).toHaveStyle({
      width: "380px",
    });
  });

  it("hides the inspector and its handle when collapsed", () => {
    setup(false);
    expect(screen.queryByText("inspector")).not.toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("widens the inspector with the left arrow key", () => {
    setup();
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
    expect(screen.getByText("inspector").parentElement).toHaveStyle({
      width: "404px",
    });
  });

  it("narrows it with the right arrow key", () => {
    setup();
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
    expect(screen.getByText("inspector").parentElement).toHaveStyle({
      width: "356px",
    });
  });

  it("ignores keys that are not a resize", () => {
    setup();
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowUp" });
    expect(screen.getByText("inspector").parentElement).toHaveStyle({
      width: "380px",
    });
  });

  it("exposes the handle to assistive tech and the keyboard", () => {
    setup();
    const sep = screen.getByRole("separator");
    expect(sep).toHaveAttribute("aria-orientation", "vertical");
    expect(sep).toHaveAttribute("tabindex", "0");
  });
});
