import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Switch } from "./switch";

afterEach(cleanup);

describe("Switch", () => {
  it("reflects checked state", () => {
    render(<Switch checked aria-label="demo" onCheckedChange={vi.fn()} />);
    expect(screen.getByRole("switch", { name: "demo" })).toBeChecked();
  });

  it("reports a toggle", () => {
    const onChange = vi.fn();
    render(
      <Switch checked={false} aria-label="demo" onCheckedChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "demo" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
