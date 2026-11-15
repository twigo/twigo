import { readFileSync } from "node:fs";
import { join } from "node:path";
import Color from "colorjs.io";
import { expect, test } from "vitest";

type Theme = "dark" | "light";
type Surface = "shell" | "editor" | "card" | "popover" | "selected";

const THEMES: readonly Theme[] = ["dark", "light"];
const ROLES = ["strong", "content", "support", "quiet"] as const;
const SURFACES: readonly Surface[] = [
  "shell",
  "editor",
  "card",
  "popover",
  "selected",
];

const read = (file: string) =>
  readFileSync(join(import.meta.dirname, file), "utf8");
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const themeCss = read("theme.css");

function declarations(body: string | undefined) {
  if (body === undefined) throw new Error("a style block is missing");
  const found = new Map<string, string>();
  for (const [, name, value] of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    if (name !== undefined && value !== undefined) {
      found.set(name, value.trim().replace(/\s+/g, " "));
    }
  }
  return found;
}

const block = (selector: RegExp) =>
  declarations(
    new RegExp(`^${selector.source} \\{([\\s\\S]*?)^\\}`, "m").exec(
      withoutComments(themeCss),
    )?.[1],
  );
const tokens: Record<Theme, Map<string, string>> = {
  light: block(/:root/),
  dark: block(/\.dark/),
};
const underCursor = declarations(
  /\[aria-selected="true"\],\s*\[data-cursor\]\s*\{([^}]*)\}/.exec(
    withoutComments(read("index.css")),
  )?.[1],
);

const COLOUR = String.raw`(?:var\(--[\w-]+\)|oklch\([^)]*\))`;
const REFERENCE = /^var\(--([\w-]+)\)$/;
const MIX = new RegExp(
  String.raw`^color-mix\(in oklab, (${COLOUR}) (\d+)%, (${COLOUR})\)$`,
);

function colour(
  value: string,
  theme: Theme,
  local?: Map<string, string>,
): Color {
  const reference = REFERENCE.exec(value);
  if (reference?.[1]) {
    const name = reference[1];
    const found =
      local?.get(name) ??
      (theme === "dark" ? tokens.dark.get(name) : undefined) ??
      tokens.light.get(name);
    if (found === undefined) throw new Error(`no token --${name}`);
    return colour(found, theme, local);
  }
  const mix = MIX.exec(value);
  if (mix?.[1] && mix[2] && mix[3]) {
    return Color.mix(
      colour(mix[1], theme, local),
      colour(mix[3], theme, local),
      1 - Number(mix[2]) / 100,
      { space: "oklab", premultiplied: true },
    );
  }
  return new Color(value);
}

const channel = (value: number | null) =>
  Math.round(Math.min(Math.max(value ?? 0, 0), 1) * 255) / 255;

const eightBit = (colour: Color) => {
  const [r, g, b] = colour.to("srgb").coords;
  return new Color("srgb", [channel(r), channel(g), channel(b)]);
};

function over(top: Color, base: Color) {
  const [r, g, b] = top.to("srgb").coords;
  const [br, bg, bb] = base.to("srgb").coords;
  const mixed = (above: number | null, below: number | null) =>
    (above ?? 0) * top.alpha + (below ?? 0) * (1 - top.alpha);
  return eightBit(
    new Color("srgb", [mixed(r, br), mixed(g, bg), mixed(b, bb)]),
  );
}

function surface(name: Surface, theme: Theme): Color {
  if (name === "selected") {
    return over(colour("var(--selected)", theme), surface("editor", theme));
  }
  return eightBit(colour(`var(--${name})`, theme));
}

const role = (name: (typeof ROLES)[number], theme: Theme, on: Surface) =>
  eightBit(
    colour(
      `var(--${name})`,
      theme,
      on === "selected" ? underCursor : undefined,
    ),
  );

const ratio = (name: (typeof ROLES)[number], theme: Theme, on: Surface) =>
  surface(on, theme).contrast(role(name, theme, on), "WCAG21");
const lightness = (name: (typeof ROLES)[number], theme: Theme, on: Surface) =>
  Math.abs(surface(on, theme).contrast(role(name, theme, on), "APCA"));

test.each(THEMES)(
  "%s: every role reads at 4.5:1 or more on the shell, the editor, a card, a popover and a selected row",
  (theme) => {
    const short = SURFACES.flatMap((on) =>
      ROLES.map((name) => ({ name, on, ratio: ratio(name, theme, on) })),
    )
      .filter((reading) => reading.ratio < 4.5)
      .map(({ name, on, ratio }) => `${name} on ${on}: ${ratio.toFixed(2)}`);
    expect(short).toEqual([]);
  },
);

test("the comment over the roles states the contrast the colours give, to the precision it states", () => {
  const columns = [
    ["dark", "shell"],
    ["dark", "editor"],
    ["light", "shell"],
    ["light", "editor"],
  ] as const;
  const claimed = Object.fromEntries(
    ROLES.map((name) => {
      const row = new RegExp(
        String.raw`^\s*${name}\s+((?:\d+\.\d / \d+\s*){4})$`,
        "m",
      ).exec(themeCss)?.[1];
      return [
        name,
        [...(row ?? "").matchAll(/(\d+\.\d) \/ (\d+)/g)].map(
          ([, shown, lc]) => `${shown} / ${lc}`,
        ),
      ];
    }),
  );
  const actual = Object.fromEntries(
    ROLES.map((name) => [
      name,
      columns.map(
        ([theme, on]) =>
          `${ratio(name, theme, on).toFixed(1)} / ${String(Math.round(lightness(name, theme, on)))}`,
      ),
    ]),
  );
  expect(claimed).toEqual(actual);
});

test.each(THEMES)(
  "%s: strong, content, support and quiet fall in lightness contrast on the editor",
  (theme) => {
    const contrast = ROLES.map((name) => lightness(name, theme, "editor"));
    expect(contrast).toEqual([...contrast].sort((a, b) => b - a));
    expect(new Set(contrast).size).toBe(ROLES.length);
  },
);
