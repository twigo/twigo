import { readFileSync } from "node:fs";
import { join } from "node:path";
import Color from "colorjs.io";
import { expect, test } from "vitest";

type Theme = "dark" | "light";
type Tone = "error" | "warn";
type Ground = "editor" | "sidebar";
type Band = `${Tone} band on ${Ground}` | `hovered ${Tone} band on ${Ground}`;
type Surface = "shell" | Ground | "card" | "popover" | "selected" | Band;

const THEMES: readonly Theme[] = ["dark", "light"];
const ROLES = ["strong", "content", "support", "quiet"] as const;
const TONES: readonly Tone[] = ["error", "warn"];
const GROUNDS: readonly Ground[] = ["editor", "sidebar"];
const BANDS: readonly Band[] = GROUNDS.flatMap((ground) =>
  TONES.flatMap((tone): Band[] => [
    `${tone} band on ${ground}`,
    `hovered ${tone} band on ${ground}`,
  ]),
);
const SURFACES: readonly Surface[] = [
  "shell",
  ...GROUNDS,
  "card",
  "popover",
  "selected",
  ...BANDS,
];
const TONE_TEXT: Record<Tone, string> = {
  error: "error",
  warn: "warn-foreground",
};

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
const underTint = declarations(
  /\[aria-selected="true"\],\s*\[data-cursor\],\s*\[data-tone\]\s*\{([^}]*)\}/.exec(
    withoutComments(read("index.css")),
  )?.[1],
);

const toneRule = (tone: Tone) =>
  declarations(
    new RegExp(String.raw`\[data-tone="${tone}"\]\s*\{([^}]*)\}`).exec(
      withoutComments(read("index.css")),
    )?.[1],
  );

const COLOUR = String.raw`(?:var\(--[\w-]+\)|oklch\([^)]*\)|transparent)`;
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

const BAND = /^(hovered )?(error|warn) band on (editor|sidebar)$/;

function surface(name: Surface, theme: Theme): Color {
  if (name === "selected") {
    return over(colour("var(--selected)", theme), surface("editor", theme));
  }
  const band = BAND.exec(name);
  if (band?.[2] && band[3]) {
    const tint = toneRule(band[2] as Tone).get("band");
    if (tint === undefined) throw new Error(`no band for a ${band[2]} row`);
    const resting = over(
      colour(tint, theme),
      surface(band[3] as Ground, theme),
    );
    return band[1] ? over(colour("var(--row-hover)", theme), resting) : resting;
  }
  return eightBit(colour(`var(--${name})`, theme));
}

const tinted = (on: Surface) => on === "selected" || BAND.test(on);

const role = (name: (typeof ROLES)[number], theme: Theme, on: Surface) =>
  eightBit(colour(`var(--${name})`, theme, tinted(on) ? underTint : undefined));

const ratio = (name: (typeof ROLES)[number], theme: Theme, on: Surface) =>
  surface(on, theme).contrast(role(name, theme, on), "WCAG21");
const lightness = (name: (typeof ROLES)[number], theme: Theme, on: Surface) =>
  Math.abs(surface(on, theme).contrast(role(name, theme, on), "APCA"));

test.each(THEMES)(
  "%s: every role reads at 4.5:1 or more on the shell, the editor, the side bar, a card, a popover, a selected row and a problem row's band on the editor and on the side bar, at rest and hovered",
  (theme) => {
    const short = SURFACES.flatMap((on) =>
      ROLES.map((name) => ({ name, on, ratio: ratio(name, theme, on) })),
    )
      .filter((reading) => reading.ratio < 4.5)
      .map(({ name, on, ratio }) => `${name} on ${on}: ${ratio.toFixed(2)}`);
    expect(short).toEqual([]);
  },
);

const PINNED_SHORT_TONED: Record<Theme, readonly string[]> = {
  dark: [],
  light: ["error text on hovered error band on sidebar: 4.48"],
};

test.each(THEMES)(
  "%s: text in a tone reads at 4.5:1 or more on its own band on the editor and the side bar, at rest and hovered, and on a selected row, but for the pair pinned above",
  (theme) => {
    const short = TONES.flatMap((tone) =>
      [...BANDS.filter((on) => BAND.exec(on)?.[2] === tone), "selected"].map(
        (on) => ({
          tone,
          on,
          ratio: surface(on as Surface, theme).contrast(
            eightBit(colour(`var(--${TONE_TEXT[tone]})`, theme)),
            "WCAG21",
          ),
        }),
      ),
    )
      .filter((reading) => reading.ratio < 4.5)
      .map(
        ({ tone, on, ratio }) => `${tone} text on ${on}: ${ratio.toFixed(2)}`,
      );
    expect(short).toEqual(PINNED_SHORT_TONED[theme]);
  },
);

test("a row's tone sets its own band and edge", () => {
  expect(
    Object.fromEntries(
      TONES.map((tone) => [
        tone,
        [toneRule(tone).get("band"), toneRule(tone).get("edge")],
      ]),
    ),
  ).toEqual({
    error: ["var(--band-error)", "var(--error)"],
    warn: ["var(--band-warn)", "var(--warn)"],
  });
});

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

const WELLED: readonly Surface[] = ["shell", "editor", "card", "popover"];
const KEYCAPPED: readonly Surface[] = ["shell", "editor"];
const WELL_TEXTS = ["content", "support", "error", "warn-foreground"] as const;
const OVERLAY_DIFFERS = 1.1;

interface Reading {
  readonly what: string;
  readonly value: number;
  readonly least: number;
}

const reading = (what: string, value: number, least: number): Reading => ({
  what,
  value,
  least,
});
const unmet = (readings: readonly Reading[]) =>
  readings
    .filter(({ value, least }) => value < least)
    .map(({ what, value }) => `${what}: ${value.toFixed(2)}`);
const textOn = (name: string, theme: Theme, under: Color) =>
  under.contrast(eightBit(colour(`var(--${name})`, theme)), "WCAG21");

function overlays(theme: Theme, on: Surface) {
  const well = over(colour("var(--well)", theme), surface(on, theme));
  return { well, plate: over(colour("var(--plate)", theme), well) };
}

test.each(THEMES)(
  "%s: a field's well differs from the shell, the editor, a card and a popover, and the typed text, the placeholder and a keycap read on it at 4.5:1 or more",
  (theme) => {
    const found = WELLED.flatMap((on) => {
      const { well } = overlays(theme, on);
      const keycap = over(colour("var(--row-active)", theme), well);
      return [
        reading(
          `the well against ${on}`,
          surface(on, theme).contrast(well, "WCAG21"),
          OVERLAY_DIFFERS,
        ),
        reading(
          `content on the well on ${on}`,
          textOn("content", theme, well),
          4.5,
        ),
        reading(
          `support on the well on ${on}`,
          textOn("support", theme, well),
          4.5,
        ),
        ...(KEYCAPPED.includes(on)
          ? [
              reading(
                `support on a keycap in the well on ${on}`,
                textOn("support", theme, keycap),
                4.5,
              ),
            ]
          : []),
      ];
    });
    expect(unmet(found)).toEqual([]);
  },
);

test.each(THEMES)(
  "%s: the pressed plate differs from the track, and support, content and the error and warning tones read at 4.5:1 or more on both, over the shell, the editor, a card and a popover",
  (theme) => {
    const found = WELLED.flatMap((on) => {
      const { well, plate } = overlays(theme, on);
      return [
        reading(
          `the plate against the track on ${on}`,
          plate.contrast(well, "WCAG21"),
          OVERLAY_DIFFERS,
        ),
        ...WELL_TEXTS.flatMap((name) => [
          reading(
            `${name} on the track on ${on}`,
            textOn(name, theme, well),
            4.5,
          ),
          reading(
            `${name} on the plate on ${on}`,
            textOn(name, theme, plate),
            4.5,
          ),
        ]),
      ];
    });
    expect(unmet(found)).toEqual([]);
  },
);

test.each(THEMES)(
  "%s: strong, content, support and quiet fall in lightness contrast on the editor",
  (theme) => {
    const contrast = ROLES.map((name) => lightness(name, theme, "editor"));
    expect(contrast).toEqual([...contrast].sort((a, b) => b - a));
    expect(new Set(contrast).size).toBe(ROLES.length);
  },
);
