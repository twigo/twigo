import { expect, test } from "vitest";
import type { KeyboardLayout } from "@twigo/protocol";
import dvorak from "../../../protocol/src/mock/layouts/dvorak.json";
import french from "../../../protocol/src/mock/layouts/french.json";
import german from "../../../protocol/src/mock/layouts/german.json";
import ukrainian from "../../../protocol/src/mock/layouts/ukrainian.json";
import us from "../../../protocol/src/mock/layouts/us.json";
import { parseKeys, type Platform } from "./chord";
import { isBare, KeyboardMapper } from "./mapper";

const LAYOUTS: Record<string, KeyboardLayout> = {
  us,
  german,
  french,
  ukrainian,
  dvorak,
};

function mapped(layout: string, keys: string, platform: Platform = "mac") {
  const layoutData = LAYOUTS[layout];
  if (!layoutData) throw new Error(`no layout ${layout}`);
  const mapper = new KeyboardMapper(layoutData, platform);
  const [chord] = parseKeys(keys, platform);
  const press = mapper.press(chord);
  if (!press) return undefined;
  return { code: press.code, shift: press.shift, label: mapper.label(press) };
}

test.each([
  // A letter follows its character on Latin layouts…
  ["german", "mod+z", "KeyY", false, "⌘Z"],
  ["german", "mod+y", "KeyZ", false, "⌘Y"],
  ["french", "mod+a", "KeyQ", false, "⌘A"],
  ["french", "mod+q", "KeyA", false, "⌘Q"],
  ["dvorak", "mod+k", "KeyV", false, "⌘K"],
  ["dvorak", "mod+t", "KeyK", false, "⌘T"],
  // …and keeps its US position on Ukrainian, labelled with the Latin letter.
  ["ukrainian", "mod+k", "KeyK", false, "⌘K"],
  ["ukrainian", "mod+shift+p", "KeyP", true, "⇧⌘P"],
  // A digit keeps its position, though AZERTY types it with Shift.
  ["french", "mod+1", "Digit1", false, "⌘1"],
  // Punctuation follows the key that types it, adding Shift where needed.
  ["german", "mod+/", "Digit7", true, "⇧⌘7"],
  ["dvorak", "mod+/", "BracketLeft", false, "⌘/"],
  ["us", "shift+/", "Slash", true, "⇧/"],
  ["us", "?", "Slash", true, "⇧/"],
  // Named keys sit where they sit.
  ["french", "mod+enter", "Enter", false, "⌘↩"],
])("%s: %s → %s", (layout, keys, code, shift, label) => {
  expect(mapped(layout, keys)).toEqual({ code, shift, label });
});

test("labels on Linux spell the modifiers out", () => {
  expect(mapped("german", "ctrl+shift+z", "linux")?.label).toBe("Ctrl+Shift+Z");
  expect(mapped("us", "meta+escape", "linux")?.label).toBe("Super+Esc");
});

test("a character no key types, not even on the US layout, has no press", () => {
  expect(mapped("us", "mod+é")).toBeUndefined();
});

test("bare presses are the writing-system keys without Ctrl, Alt or Cmd", () => {
  const mapper = new KeyboardMapper(us, "mac");
  const press = (keys: string) => {
    const [chord] = parseKeys(keys, "mac");
    const found = mapper.press(chord);
    if (!found) throw new Error(`no press for ${keys}`);
    return found;
  };
  expect(isBare(press("j"))).toBe(true);
  expect(isBare(press("shift+g"))).toBe(true);
  expect(isBare(press("space"))).toBe(true);
  expect(isBare(press("escape"))).toBe(false);
  expect(isBare(press("mod+j"))).toBe(false);
  expect(isBare(press("alt+j"))).toBe(false);
});
