import { describe, it, expect } from "vitest";
import { toAccelerator } from "./menu";

describe("toAccelerator", () => {
  it("maps a keybinding to Tauri accelerator syntax", () => {
    expect(toAccelerator("mod+shift+p")).toBe("CmdOrCtrl+Shift+P");
    expect(toAccelerator("mod+,")).toBe("CmdOrCtrl+,");
    expect(toAccelerator("mod+alt+b")).toBe("CmdOrCtrl+Alt+B");
    expect(toAccelerator("mod+\\")).toBe("CmdOrCtrl+\\");
    expect(toAccelerator("mod+=")).toBe("CmdOrCtrl+=");
    expect(toAccelerator("mod+-")).toBe("CmdOrCtrl+-");
    expect(toAccelerator("mod+0")).toBe("CmdOrCtrl+0");
  });
});
