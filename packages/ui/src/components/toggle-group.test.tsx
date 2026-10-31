import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group";

afterEach(cleanup);

function Segmented({ onChange }: { onChange?: (v: string) => void }) {
  return (
    <ToggleGroup
      type="single"
      defaultValue="json"
      onValueChange={onChange}
      aria-label="format"
    >
      <ToggleGroupItem value="json">json</ToggleGroupItem>
      <ToggleGroupItem value="text">text</ToggleGroupItem>
    </ToggleGroup>
  );
}

describe("ToggleGroup", () => {
  it("marks the active item with data-state=on", () => {
    render(<Segmented />);
    expect(screen.getByRole("radio", { name: "json" })).toHaveAttribute(
      "data-state",
      "on",
    );
    expect(screen.getByRole("radio", { name: "text" })).toHaveAttribute(
      "data-state",
      "off",
    );
  });

  it("reports the selected value on change", () => {
    const onChange = vi.fn();
    render(<Segmented onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "text" }));
    expect(onChange).toHaveBeenCalledWith("text");
  });
});
