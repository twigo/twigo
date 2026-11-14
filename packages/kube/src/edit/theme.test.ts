import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { editor } from "monaco-editor/editor";

const fake = vi.hoisted(() => ({
  themes: [] as { name: string; data: editor.IStandaloneThemeData }[],
  set: [] as string[],
}));

vi.mock("monaco-editor/editor", () => ({
  editor: {
    defineTheme: (name: string, data: editor.IStandaloneThemeData) =>
      fake.themes.push({ name, data }),
    setTheme: (name: string) => fake.set.push(name),
  },
}));

const COLOURS = {
  "editor.background": "editor",
  "editor.foreground": "content",
  "editorLineNumber.foreground": "quiet",
  "editorLineNumber.activeForeground": "support",
  "editor.selectionBackground": "selected",
  "editor.lineHighlightBackground": "row-hover",
  "editorIndentGuide.background1": "border-subtle",
  "editorCursor.foreground": "content",
  "editorBracketHighlight.foreground1": "content",
  "editor.findMatchBackground": "mark-current",
  "editor.findMatchHighlightBackground": "mark",
  "editor.findMatchHighlightForeground": "mark-current-foreground",
};
const COMMENT = "support";
const TOKENS = [...new Set([...Object.values(COLOURS), COMMENT])];

const value = (token: string, dark: boolean) => {
  const n = TOKENS.indexOf(token) + 1;
  const hex = n.toString(16).padStart(2, "0");
  return `#${hex}${dark ? "20" : "10"}00${token === "mark" ? "80" : ""}`;
};

const tokens = (dark: boolean) =>
  TOKENS.map((token) => `--${token}:${value(token, dark)};`).join("");

const watching: MutationObserver[] = [];

vi.stubGlobal(
  "MutationObserver",
  class extends MutationObserver {
    constructor(callback: MutationCallback) {
      super(callback);
      watching.push(this);
    }
  },
);

vi.stubGlobal(
  "OffscreenCanvas",
  class {
    getContext() {
      return {
        fillStyle: "",
        clearRect: () => undefined,
        fillRect: () => undefined,
        getImageData(this: { fillStyle: string }) {
          const [, ...channels] =
            /^#(..)(..)(..)(..)?$/.exec(this.fillStyle) ?? [];
          const [r = "00", g = "00", b = "00", a = "ff"] = channels;
          return {
            data: Uint8ClampedArray.from([r, g, b, a], (c) => parseInt(c, 16)),
          };
        },
      };
    }
  },
);

const root = document.documentElement;
let style: HTMLStyleElement;

async function start() {
  vi.resetModules();
  const { followTheme } = await import("./theme");
  followTheme();
}

beforeEach(() => {
  style = document.createElement("style");
  style.textContent = `:root{${tokens(false)}} .dark{${tokens(true)}}`;
  document.head.append(style);
});

afterEach(() => {
  for (const observer of watching.splice(0)) observer.disconnect();
  style.remove();
  root.classList.remove("dark", "compact");
  fake.themes.length = 0;
  fake.set.length = 0;
});

test.each([false, true])(
  "the tokens become Monaco's colours (dark: %s)",
  async (dark) => {
    if (dark) root.classList.add("dark");
    await start();

    const [theme] = fake.themes;
    expect(theme?.name).toBe(dark ? "twigo-dark" : "twigo-light");
    expect(theme?.data.base).toBe(dark ? "vs-dark" : "vs");
    expect(theme?.data.colors).toMatchObject(
      Object.fromEntries(
        Object.entries(COLOURS).map(([key, token]) => [
          key,
          value(token, dark),
        ]),
      ),
    );
    expect(
      theme?.data.rules.find(({ token }) => token === "comment")?.foreground,
    ).toBe(value(COMMENT, dark));
    expect(fake.set).toEqual([theme?.name]);
  },
);

test("the theme follows .dark on <html>, resolving the tokens anew each time, and ignores other classes", async () => {
  await start();
  expect(fake.set).toEqual(["twigo-light"]);

  root.classList.add("dark");
  await vi.waitFor(() => {
    expect(fake.set).toEqual(["twigo-light", "twigo-dark"]);
  });
  expect(fake.themes[1]?.data.colors["editor.background"]).toBe(
    value("editor", true),
  );

  root.classList.add("compact");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(fake.set).toEqual(["twigo-light", "twigo-dark"]);

  root.classList.remove("dark");
  await vi.waitFor(() => {
    expect(fake.set).toEqual(["twigo-light", "twigo-dark", "twigo-light"]);
  });
  expect(fake.themes[2]?.data.colors["editor.background"]).toBe(
    value("editor", false),
  );
});
