import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FormatToggle } from "./FormatToggle";

describe("FormatToggle", () => {
  afterEach(cleanup);

  it("marks the active format", () => {
    render(<FormatToggle value="text" onChange={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "text" })).toHaveAttribute(
      "data-state",
      "on",
    );
    expect(screen.getByRole("radio", { name: "json" })).toHaveAttribute(
      "data-state",
      "off",
    );
  });

  it("reports the chosen format", () => {
    const onChange = vi.fn();
    render(<FormatToggle value="json" onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "hex" }));
    expect(onChange).toHaveBeenCalledWith("hex");
  });

  it("keeps a format when the active item is clicked again", () => {
    const onChange = vi.fn();
    render(<FormatToggle value="json" onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "json" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
