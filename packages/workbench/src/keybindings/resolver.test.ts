import { describe, expect, test } from "vitest";
import type { ContextValue } from "../contextkey/when";
import { KeySyntaxError } from "./chord";
import { KeyboardMapper, type Press } from "./mapper";
import { platformOf } from "./platform";
import { Resolver, validate, type Source } from "./resolver";

const US_BY_DEFAULT = new KeyboardMapper({ id: "us", keys: {} }, "mac");

const LIST: Record<string, ContextValue> = { listFocus: true };

function press(code: string, modifiers = ""): Press {
  return {
    code,
    ctrl: modifiers.includes("ctrl"),
    shift: modifiers.includes("shift"),
    alt: modifiers.includes("alt"),
    meta: modifiers.includes("meta"),
  };
}

function resolver(...sources: Source[]) {
  return new Resolver(sources, US_BY_DEFAULT);
}

function resolve(
  target: Resolver,
  presses: Press[],
  context: Record<string, ContextValue> = {},
  enabled: (command: string) => boolean = () => true,
) {
  const last = presses.pop();
  if (!last) throw new Error("no press");
  const result = target.resolve(
    presses,
    last,
    (key) => context[key],
    (binding) => enabled(binding.command),
  );
  return result.kind === "command" ? result.binding.command : result.kind;
}

const K = press("KeyK", "meta");

describe("weights", () => {
  test("a heavier source wins whatever the registration order", () => {
    const target = resolver(
      { weight: "user", rules: [{ key: "mod+k", command: "user" }] },
      { weight: "extension", rules: [{ key: "mod+k", command: "extension" }] },
      { weight: "core", rules: [{ key: "mod+k", command: "core" }] },
      { weight: "builtin", rules: [{ key: "mod+k", command: "builtin" }] },
    );
    expect(resolve(target, [K])).toBe("user");
  });

  test.each([
    [{}, "core"],
    [{ editorFocus: true }, "extension"],
  ])("the last rule whose when holds wins in %o", (context, expected) => {
    const target = resolver(
      { weight: "core", rules: [{ key: "mod+k", command: "core" }] },
      {
        weight: "extension",
        rules: [{ key: "mod+k", command: "extension", when: "editorFocus" }],
      },
    );
    expect(resolve(target, [K], context)).toBe(expected);
  });

  test("within a weight the later rule wins", () => {
    const target = resolver({
      weight: "core",
      rules: [
        { key: "mod+k", command: "first" },
        { key: "mod+k", command: "second" },
      ],
    });
    expect(resolve(target, [K])).toBe("second");
  });

  test("a disabled command lets the next rule fire", () => {
    const target = resolver({
      weight: "core",
      rules: [
        { key: "mod+k", command: "fallback" },
        { key: "mod+k", command: "disabled" },
      ],
    });
    expect(resolve(target, [K], {}, (command) => command !== "disabled")).toBe(
      "fallback",
    );
  });
});

describe("chords", () => {
  const target = resolver({
    weight: "core",
    rules: [
      { key: "mod+k mod+s", command: "keybindings" },
      { key: "mod+k v", command: "preview" },
      { key: "mod+s", command: "save" },
    ],
  });

  test("the first chord waits for the second", () => {
    expect(resolve(target, [K])).toBe("chord");
    expect(resolve(target, [K, press("KeyS", "meta")])).toBe("keybindings");
  });

  test("a bare second chord fires outside a list", () => {
    expect(resolve(target, [K, press("KeyV")])).toBe("preview");
  });

  test("a second chord that continues nothing resolves to none", () => {
    expect(resolve(target, [K, press("KeyX", "meta")])).toBe("none");
  });

  test("the second chord alone is its own binding", () => {
    expect(resolve(target, [press("KeyS", "meta")])).toBe("save");
  });

  test("a single-chord rule registered later shadows the chord", () => {
    const shadowed = resolver(
      {
        weight: "core",
        rules: [{ key: "mod+k mod+s", command: "keybindings" }],
      },
      { weight: "user", rules: [{ key: "mod+k", command: "user" }] },
    );
    expect(resolve(shadowed, [K])).toBe("user");
  });
});

describe("removals", () => {
  const core: Source = {
    weight: "core",
    rules: [
      { key: "mod+k", command: "open", when: "listFocus" },
      { key: "mod+o", command: "open" },
    ],
  };

  test("-command removes every default binding of the command", () => {
    const target = resolver(core, {
      weight: "user",
      rules: [{ command: "-open" }],
    });
    expect(target.bindingsOf("open")).toEqual([]);
  });

  test("a key narrows the removal", () => {
    const target = resolver(core, {
      weight: "user",
      rules: [{ key: "mod+o", command: "-open" }],
    });
    expect(resolve(target, [press("KeyO", "meta")])).toBe("none");
    expect(resolve(target, [K], LIST)).toBe("open");
  });

  test("a when narrows the removal to an identical when", () => {
    const target = resolver(core, {
      weight: "user",
      rules: [{ command: "-open", when: "listFocus " }],
    });
    expect(resolve(target, [K], LIST)).toBe("none");
    expect(resolve(target, [press("KeyO", "meta")])).toBe("open");
  });

  test("a removal spares the user's own bindings", () => {
    const target = resolver(core, {
      weight: "user",
      rules: [{ key: "mod+u", command: "open" }, { command: "-open" }],
    });
    expect(resolve(target, [press("KeyU", "meta")])).toBe("open");
  });
});

describe("bare keys", () => {
  const target = resolver({
    weight: "core",
    rules: [
      { key: "l", command: "logs" },
      { key: "shift+j", command: "owner" },
      { key: "escape", command: "clear" },
    ],
  });

  test("fire only while a list has the focus", () => {
    expect(resolve(target, [press("KeyL")], LIST)).toBe("logs");
    expect(resolve(target, [press("KeyL")])).toBe("none");
    expect(resolve(target, [press("KeyJ", "shift")], LIST)).toBe("owner");
    expect(resolve(target, [press("KeyJ", "shift")])).toBe("none");
  });

  test("never fire in an input, even inside a list", () => {
    expect(
      resolve(target, [press("KeyL")], { listFocus: true, inputFocus: true }),
    ).toBe("none");
  });

  test("named keys are not bare", () => {
    expect(resolve(target, [press("Escape")])).toBe("clear");
  });
});

describe("platforms", () => {
  test("a platform variant replaces the key on its platform only", () => {
    const rules: Source = {
      weight: "core",
      rules: [{ key: "ctrl+shift+p", mac: "cmd+shift+p", command: "palette" }],
    };
    const mac = new Resolver([rules], US_BY_DEFAULT);
    const linux = new Resolver(
      [rules],
      new KeyboardMapper({ id: "us", keys: {} }, "linux"),
    );
    expect(mac.bindingsOf("palette")[0]?.presses).toEqual([
      press("KeyP", "meta shift"),
    ]);
    expect(linux.bindingsOf("palette")[0]?.presses).toEqual([
      press("KeyP", "ctrl shift"),
    ]);
  });

  test("mod is Cmd on macOS and Ctrl elsewhere", () => {
    const rules: Source = {
      weight: "core",
      rules: [{ key: "mod+b", command: "b" }],
    };
    const linux = new Resolver(
      [rules],
      new KeyboardMapper({ id: "us", keys: {} }, "linux"),
    );
    expect(linux.bindingsOf("b")[0]?.presses).toEqual([press("KeyB", "ctrl")]);
    expect(resolver(rules).bindingsOf("b")[0]?.presses).toEqual([
      press("KeyB", "meta"),
    ]);
  });
});

test("bindingsOf lists the winning binding first", () => {
  const target = resolver(
    { weight: "core", rules: [{ key: "mod+a", command: "x" }] },
    { weight: "user", rules: [{ key: "mod+b", command: "x" }] },
  );
  expect(
    target.bindingsOf("x").map((binding) => binding.presses[0].code),
  ).toEqual(["KeyB", "KeyA"]);
});

test("validate rejects bad keys and bad whens", () => {
  expect(() => validate({ key: "hyper+k", command: "x" }, "mac")).toThrow(
    KeySyntaxError,
  );
  expect(() => validate({ key: "mod+", command: "x" }, "mac")).toThrow(
    KeySyntaxError,
  );
  expect(() =>
    validate({ key: "mod+k", command: "x", when: "a &&" }, "mac"),
  ).toThrow();
  expect(() => validate({ command: "-x", when: "(" }, "mac")).toThrow();
  expect(() =>
    validate({ key: "mod+k mod+s", command: "x" }, "mac"),
  ).not.toThrow();
});

test.each([
  [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    "mac",
  ],
  ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15", "linux"],
  [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/141.0",
    "win",
  ],
])("%s runs on %s", (agent, platform) => {
  expect(platformOf(agent)).toBe(platform);
});
