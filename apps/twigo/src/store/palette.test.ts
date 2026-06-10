import { describe, it, expect, beforeEach } from "vitest";
import { usePalette } from "./palette";

describe("palette store", () => {
  beforeEach(() => {
    usePalette.setState({ open: false });
  });

  it("toggles and sets the open state", () => {
    usePalette.getState().toggle();
    expect(usePalette.getState().open).toBe(true);
    usePalette.getState().toggle();
    expect(usePalette.getState().open).toBe(false);
    usePalette.getState().setOpen(true);
    expect(usePalette.getState().open).toBe(true);
  });
});
