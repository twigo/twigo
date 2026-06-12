import { describe, it, expect, vi } from "vitest";
import {
  getCommands,
  keybindingHelp,
  matchKeybinding,
  fmtBinding,
  isTypingTarget,
} from "./commands";
import { canSplitActiveEditor, editorGroupCount } from "@/lib/editor";
import { useHelp } from "@/store/help";
import { registerView, clearViews } from "@/shell/views";
import { Radio } from "lucide-react";

vi.mock("@/lib/editor", () => ({
  openSettings: vi.fn(),
  splitActiveEditor: vi.fn(),
  focusNextEditorGroup: vi.fn(),
  resetEditorLayout: vi.fn(),
  canSplitActiveEditor: vi.fn(() => false),
  editorGroupCount: vi.fn(() => 0),
}));

const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("command registry", () => {
  it("gates editor split commands behind a splittable layout", () => {
    vi.mocked(canSplitActiveEditor).mockReturnValue(false);
    expect(getCommands().some((c) => c.id === "editor.splitRight")).toBe(false);
    vi.mocked(canSplitActiveEditor).mockReturnValue(true);
    const split = getCommands().find((c) => c.id === "editor.splitRight");
    expect(split).toBeDefined();
    expect(split?.keybinding).toBe("mod+\\");
    vi.mocked(canSplitActiveEditor).mockReturnValue(false);
  });

  it("gates focus/reset commands behind multiple editor groups", () => {
    vi.mocked(editorGroupCount).mockReturnValue(0);
    expect(getCommands().some((c) => c.id === "editor.resetLayout")).toBe(
      false,
    );
    vi.mocked(editorGroupCount).mockReturnValue(2);
    expect(getCommands().some((c) => c.id === "editor.resetLayout")).toBe(true);
    vi.mocked(editorGroupCount).mockReturnValue(0);
  });

  it("offers a go-to command for each registered view", () => {
    clearViews();
    registerView({ id: "subjects", title: "Subjects", icon: Radio });
    registerView({ id: "responders", title: "Responders", icon: Radio });
    const ids = getCommands().map((c) => c.id);
    expect(ids).toContain("view.subjects");
    expect(ids).toContain("view.responders");
    clearViews();
  });

  it("binds settings to the conventional mod+,", () => {
    expect(
      getCommands().find((c) => c.id === "settings.open")?.keybinding,
    ).toBe("mod+,");
  });
});

describe("keyboard help", () => {
  it("lists the palette and static keybindings, regardless of when()", () => {
    const help = keybindingHelp();
    expect(help.some((s) => s.title === "Command palette")).toBe(true);
    expect(help.find((s) => s.title === "Keyboard shortcuts")?.binding).toBe(
      "?",
    );
    expect(help.find((s) => s.title === "Open settings")?.binding).toBe(
      "mod+,",
    );
    // Split shortcuts show in help even when no layout is splittable right now.
    expect(help.some((s) => s.binding === "mod+\\")).toBe(true);
  });

  it("offers a command that opens the shortcuts overlay", () => {
    const cmd = getCommands().find((c) => c.id === "help.shortcuts");
    expect(cmd).toBeDefined();
    useHelp.setState({ open: false });
    cmd?.run();
    expect(useHelp.getState().open).toBe(true);
    useHelp.setState({ open: false });
  });
});

describe("matchKeybinding", () => {
  it("treats meta and ctrl as the same mod", () => {
    expect(matchKeybinding(ev({ key: "n", metaKey: true }), "mod+n")).toBe(
      true,
    );
    expect(matchKeybinding(ev({ key: "n", ctrlKey: true }), "mod+n")).toBe(
      true,
    );
    expect(matchKeybinding(ev({ key: "n" }), "mod+n")).toBe(false);
  });

  it("requires the exact modifier set", () => {
    expect(
      matchKeybinding(ev({ key: "n", metaKey: true, altKey: true }), "mod+n"),
    ).toBe(false);
    expect(
      matchKeybinding(
        ev({ key: "b", metaKey: true, altKey: true }),
        "mod+alt+b",
      ),
    ).toBe(true);
    expect(matchKeybinding(ev({ key: "b", metaKey: true }), "mod+alt+b")).toBe(
      false,
    );
  });

  it("never matches the display-only '?' binding (shift is implicit)", () => {
    // "?" is typed with Shift, but the binding can't express that, so the
    // command loop never fires it - the overlay opens via a dedicated handler.
    expect(matchKeybinding(ev({ key: "?", shiftKey: true }), "?")).toBe(false);
  });
});

describe("isTypingTarget", () => {
  const el = (tag: string, init?: (e: HTMLElement) => void) => {
    const node = document.createElement(tag);
    init?.(node);
    return node;
  };

  it("flags native fields, CodeMirror and role-based widgets", () => {
    expect(isTypingTarget(el("input"))).toBe(true);
    expect(isTypingTarget(el("textarea"))).toBe(true);
    const cm = el("div", (e) => (e.className = "cm-editor"));
    const inner = el("span");
    cm.appendChild(inner);
    expect(isTypingTarget(inner)).toBe(true);
    for (const role of ["textbox", "searchbox", "combobox"]) {
      expect(
        isTypingTarget(el("div", (e) => e.setAttribute("role", role))),
      ).toBe(true);
    }
  });

  it("ignores plain elements and non-elements", () => {
    expect(isTypingTarget(el("div"))).toBe(false);
    expect(isTypingTarget(el("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("fmtBinding", () => {
  it("renders a readable shortcut", () => {
    expect(fmtBinding("mod+n")).toMatch(/(⌘|Ctrl\+)N/);
  });

  it("orders modifiers by platform convention (Command last on mac)", () => {
    expect(fmtBinding("mod+shift+p")).toMatch(/^(⇧⌘P|Ctrl\+Shift\+P)$/);
    expect(fmtBinding("mod+alt+b")).toMatch(/^(⌥⌘B|Ctrl\+Alt\+B)$/);
  });
});
