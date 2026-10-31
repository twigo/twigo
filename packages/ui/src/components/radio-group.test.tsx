import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RadioGroup, RadioGroupItem } from "./radio-group";

afterEach(cleanup);

function Fixture({ onChange }: { onChange?: (v: string) => void }) {
  return (
    <RadioGroup defaultValue="all" onValueChange={onChange} aria-label="mode">
      <RadioGroupItem value="all" aria-label="all" />
      <RadioGroupItem value="keep" aria-label="keep" />
    </RadioGroup>
  );
}

describe("RadioGroup", () => {
  it("checks the default item", () => {
    render(<Fixture />);
    expect(screen.getByRole("radio", { name: "all" })).toHaveAttribute(
      "data-state",
      "checked",
    );
    expect(screen.getByRole("radio", { name: "keep" })).toHaveAttribute(
      "data-state",
      "unchecked",
    );
  });

  it("reports the picked value", () => {
    const onChange = vi.fn();
    render(<Fixture onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "keep" }));
    expect(onChange).toHaveBeenCalledWith("keep");
  });
});
