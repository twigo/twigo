import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./select";

// Radix Select opens into a portal that jsdom can't lay out, so (per the repo's
// convention of not driving portal components in jsdom) these cover the closed
// trigger contract only.
function Fixture({ disabled }: { disabled?: boolean }) {
  return (
    <Select value="text" disabled={disabled}>
      <SelectTrigger aria-label="format">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="json">json</SelectItem>
        <SelectItem value="text">text</SelectItem>
      </SelectContent>
    </Select>
  );
}

afterEach(cleanup);

describe("Select", () => {
  it("renders a combobox trigger", () => {
    render(<Fixture />);
    expect(
      screen.getByRole("combobox", { name: "format" }),
    ).toBeInTheDocument();
  });

  it("disables the trigger", () => {
    render(<Fixture disabled />);
    expect(screen.getByRole("combobox", { name: "format" })).toBeDisabled();
  });
});
