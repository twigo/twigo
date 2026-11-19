import { afterEach, expect, test } from "vitest";
import { emWidth, fontOf } from "./textWidth";

afterEach(() => {
  document.body.replaceChildren();
});

test("the font of an element in the document is its computed one, and the same object while it does not change", () => {
  const element = document.createElement("span");
  element.style.fontSize = "20px";
  document.body.append(element);
  const font = fontOf(element);
  expect(font?.size).toBe(20);
  expect(fontOf(element)).toBe(font);
  expect(font && emWidth("abcd", font)).toBe(4 * (8 / 20));
});

test("an element outside the document has no font to read, since its width in em would be no number", () => {
  const element = document.createElement("span");
  element.style.fontSize = "20px";
  expect(fontOf(element)).toBeUndefined();
});
