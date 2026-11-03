import type { AnsiColor, TextStyle } from "../../generated";

/**
 * A line as the kubelet sends it with `timestamps=true`, read as Rust's
 * `logs::line` reads it: its time in RFC 3339, a space, then what the
 * container wrote, ANSI escapes and all.
 */
export interface Parsed {
  /** Nanoseconds since the Unix epoch, null for a line whose time does not parse. */
  readonly at: bigint | null;
  readonly text: string;
  readonly styles: TextStyle[];
}

/** A line without its line feed. */
export function parse(line: string): Parsed {
  const raw = line.endsWith("\n") ? line.slice(0, -1) : line;
  const space = raw.indexOf(" ");
  const at = space < 0 ? null : time(raw.slice(0, space));
  const { text, styles } = styled(at === null ? raw : raw.slice(space + 1));
  return { at, text, styles };
}

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;
const NANOS = 1_000_000_000n;
const I64 = 2n ** 63n;

/**
 * RFC 3339 in nanoseconds since the Unix epoch, as jiff 0.2 reads it: a
 * leap second as the second before, offsets up to 25 hours, and null past
 * what an i64 holds. jiff's other ISO 8601 forms are not read.
 */
export function time(text: string): bigint | null {
  const found = RFC3339.exec(text);
  if (!found) return null;
  const number = (index: number) => Number(found[index] ?? 0);
  const year = number(1);
  const month = number(2);
  const day = number(3);
  const hour = number(4);
  const minute = number(5);
  const second = number(6);
  const hours = number(9);
  const minutes = number(10);
  if (hour > 23 || minute > 59 || second > 60 || hours > 25 || minutes > 59) {
    return null;
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  const offset = (found[8] === "-" ? -1 : 1) * (hours * 3600 + minutes * 60);
  const seconds =
    date.getTime() / 1000 +
    hour * 3600 +
    minute * 60 +
    Math.min(second, 59) -
    offset;
  const at = BigInt(seconds) * NANOS + BigInt((found[7] ?? "").padEnd(9, "0"));
  return at >= -I64 && at < I64 ? at : null;
}

type Style = Omit<TextStyle, "range">;

const PLAIN: Style = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
};

function same(a: Style, b: Style): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline
  );
}

/**
 * The parser's states, as anstyle-parse 1.0 (Paul Williams' DEC ANSI
 * parser) has them; a multi-byte character is read in the ground state.
 */
type State =
  | "ground"
  | "escape"
  | "escapeIntermediate"
  | "csiEntry"
  | "csiParam"
  | "csiIntermediate"
  | "csiIgnore"
  | "dcsEntry"
  | "dcsParam"
  | "dcsIntermediate"
  | "dcsIgnore"
  | "dcsPassthrough"
  | "oscString"
  | "sosPmApcString";

/** What a byte does to the styler; the parser's other actions do nothing to it. */
type Action = "none" | "print" | "execute" | "collect" | "param" | "dispatch";

/** The state a byte moves to, undefined to stay, and its action, or the start of a multi-byte character. */
type Change = readonly [State | undefined, Action] | "utf8";

const STAY: Change = [undefined, "none"];
const EXECUTE: Change = [undefined, "execute"];

function within(byte: number, from: number, to: number): boolean {
  return byte >= from && byte <= to;
}

/** C0 controls but CAN, SUB and ESC, which act in any state. */
function c0(byte: number): boolean {
  return byte <= 0x17 || byte === 0x19 || within(byte, 0x1c, 0x1f);
}

/** anstyle-parse 1.0's state table, `src/state/codegen.rs`. */
function change(state: State, byte: number): Change {
  if (byte === 0x18 || byte === 0x1a) return ["ground", "execute"];
  if (byte === 0x1b) return ["escape", "none"];
  switch (state) {
    case "ground":
      if (within(byte, 0x20, 0x7f)) return [undefined, "print"];
      if (within(byte, 0xc2, 0xf4)) return "utf8";
      return c0(byte) ||
        within(byte, 0x80, 0x8f) ||
        within(byte, 0x91, 0x9a) ||
        byte === 0x9c
        ? EXECUTE
        : STAY;
    case "escape":
      if (c0(byte)) return EXECUTE;
      if (within(byte, 0x20, 0x2f)) return ["escapeIntermediate", "none"];
      if (byte === 0x5b) return ["csiEntry", "none"];
      if (byte === 0x5d) return ["oscString", "none"];
      if (byte === 0x50) return ["dcsEntry", "none"];
      if (byte === 0x58 || byte === 0x5e || byte === 0x5f) {
        return ["sosPmApcString", "none"];
      }
      return within(byte, 0x30, 0x7e) ? ["ground", "none"] : STAY;
    case "escapeIntermediate":
      if (c0(byte)) return EXECUTE;
      return within(byte, 0x30, 0x7e) ? ["ground", "none"] : STAY;
    case "csiEntry":
      if (c0(byte)) return EXECUTE;
      if (within(byte, 0x20, 0x2f)) return ["csiIntermediate", "collect"];
      if (within(byte, 0x30, 0x3b)) return ["csiParam", "param"];
      if (within(byte, 0x3c, 0x3f)) return ["csiParam", "collect"];
      return within(byte, 0x40, 0x7e) ? ["ground", "dispatch"] : STAY;
    case "csiParam":
      if (c0(byte)) return EXECUTE;
      if (within(byte, 0x30, 0x3b)) return [undefined, "param"];
      if (within(byte, 0x3c, 0x3f)) return ["csiIgnore", "none"];
      if (within(byte, 0x20, 0x2f)) return ["csiIntermediate", "collect"];
      return within(byte, 0x40, 0x7e) ? ["ground", "dispatch"] : STAY;
    case "csiIntermediate":
      if (c0(byte)) return EXECUTE;
      if (within(byte, 0x20, 0x2f)) return [undefined, "collect"];
      if (within(byte, 0x30, 0x3f)) return ["csiIgnore", "none"];
      return within(byte, 0x40, 0x7e) ? ["ground", "dispatch"] : STAY;
    case "csiIgnore":
      if (c0(byte)) return EXECUTE;
      return within(byte, 0x40, 0x7e) ? ["ground", "none"] : STAY;
    case "dcsEntry":
      if (within(byte, 0x20, 0x2f)) return ["dcsIntermediate", "none"];
      if (within(byte, 0x30, 0x3f)) return ["dcsParam", "none"];
      return within(byte, 0x40, 0x7e) ? ["dcsPassthrough", "none"] : STAY;
    case "dcsParam":
      if (within(byte, 0x3c, 0x3f)) return ["dcsIgnore", "none"];
      if (within(byte, 0x20, 0x2f)) return ["dcsIntermediate", "none"];
      return within(byte, 0x40, 0x7e) ? ["dcsPassthrough", "none"] : STAY;
    case "dcsIntermediate":
      if (within(byte, 0x30, 0x3f)) return ["dcsIgnore", "none"];
      return within(byte, 0x40, 0x7e) ? ["dcsPassthrough", "none"] : STAY;
    case "dcsIgnore":
    case "dcsPassthrough":
    case "sosPmApcString":
      return byte === 0x9c ? ["ground", "none"] : STAY;
    case "oscString":
      return byte === 0x07 ? ["ground", "none"] : STAY;
  }
}

/** anstyle-parse's bound on a sequence's parameters and subparameters. */
const MAX_PARAMS = 32;

/** A CSI sequence's parameters as anstyle-parse collects them, colon-joined subparameters grouped. */
class Csi {
  readonly params: number[][] = [];
  intermediates = 0;
  ignoring = false;
  #count = 0;
  #param = 0;
  #open = false;

  param(byte: number): void {
    if (this.#count === MAX_PARAMS) {
      this.ignoring = true;
    } else if (byte === 0x3b) {
      this.#push(false);
    } else if (byte === 0x3a) {
      this.#push(true);
    } else {
      this.#param = Math.min(0xffff, this.#param * 10 + byte - 0x30);
    }
  }

  collect(): void {
    if (this.intermediates === 2) this.ignoring = true;
    else this.intermediates++;
  }

  /** The parameters at the final byte, or null when the sequence was too long to read. */
  finish(): readonly (readonly number[])[] | null {
    if (this.#count === MAX_PARAMS) this.ignoring = true;
    else this.#push(false);
    return this.ignoring ? null : this.params;
  }

  #push(open: boolean): void {
    const last = this.params[this.params.length - 1];
    if (this.#open && last) last.push(this.#param);
    else this.params.push([this.#param]);
    this.#open = open;
    this.#param = 0;
    this.#count++;
  }
}

class Styler {
  text = "";
  readonly styles: TextStyle[] = [];
  style = PLAIN;
  /** Where the current style's run started, in UTF-16 units. */
  #from = 0;

  push(char: string): void {
    this.text += char;
  }

  restyle(style: Style): void {
    if (same(style, this.style)) return;
    this.close();
    this.style = style;
    this.#from = this.text.length;
  }

  /** Ends the current run, joined to the one before when they touch with the same style. */
  close(): void {
    const at = this.text.length;
    if (at === this.#from || same(this.style, PLAIN)) return;
    const last = this.styles[this.styles.length - 1];
    if (last?.range.end === this.#from && same(last, this.style)) {
      last.range.end = at;
    } else {
      this.styles.push({
        range: { start: this.#from, end: at },
        ...this.style,
      });
    }
    this.#from = at;
  }
}

/**
 * The text without its escapes, and what their SGR sequences styled, in
 * runs of UTF-16 units. A tab stays; other C0 and C1 controls go, a
 * carriage return before the line feed among them.
 */
function styled(raw: string): { text: string; styles: TextStyle[] } {
  const styler = new Styler();
  let state: State = "ground";
  let csi = new Csi();
  let code = 0;
  let left = 0;
  for (const byte of new TextEncoder().encode(raw)) {
    if (left > 0) {
      code = (code << 6) | (byte & 0x3f);
      if (--left === 0) styler.push(String.fromCodePoint(code));
      continue;
    }
    const next = change(state, byte);
    if (next === "utf8") {
      left = byte >= 0xf0 ? 3 : byte >= 0xe0 ? 2 : 1;
      code = byte & (0x7f >> (left + 1));
      continue;
    }
    const [to, action] = next;
    switch (action) {
      case "print":
        styler.push(String.fromCharCode(byte));
        break;
      case "execute":
        if (byte === 0x09) styler.push("\t");
        break;
      case "collect":
        csi.collect();
        break;
      case "param":
        csi.param(byte);
        break;
      case "dispatch": {
        const params = csi.finish();
        if (byte === 0x6d && csi.intermediates === 0 && params) {
          styler.restyle(sgr(styler.style, params));
        }
        break;
      }
      case "none":
        break;
    }
    if (to === "csiEntry") csi = new Csi();
    if (to !== undefined) state = to;
  }
  styler.close();
  return { text: styler.text, styles: styler.styles };
}

/**
 * What an SGR sequence makes of a style, as ECMA-48 and xterm read its
 * parameters, `38;5;n`, `38;2;r;g;b` and their colon forms included.
 * Blinking, inverse, hidden and struck text keep their characters and
 * lose their effect.
 */
function sgr(current: Style, params: readonly (readonly number[])[]): Style {
  let style = { ...current };
  let at = 0;
  const next = () => params[at++]?.[0];
  const semicolon = (): AnsiColor | null => {
    switch (next()) {
      case 5: {
        const index = next();
        return index === undefined ? null : indexed(index);
      }
      case 2: {
        const r = next();
        const g = r === undefined ? undefined : next();
        const b = g === undefined ? undefined : next();
        return r === undefined || g === undefined || b === undefined
          ? null
          : rgb(r, g, b);
      }
      default:
        return null;
    }
  };
  while (at < params.length) {
    const param = params[at++] ?? [];
    const [n, ...rest] = param;
    if (param.length > 1) {
      if (n === 4) style.underline = !(param.length === 2 && rest[0] === 0);
      else if (n === 38) style.fg = colon(rest);
      else if (n === 48) style.bg = colon(rest);
      continue;
    }
    switch (n) {
      case 0:
        style = { ...PLAIN };
        break;
      case 1:
        style.bold = true;
        break;
      case 2:
        style.dim = true;
        break;
      case 3:
        style.italic = true;
        break;
      case 4:
        style.underline = true;
        break;
      case 21:
        style.bold = false;
        break;
      case 22:
        style.bold = false;
        style.dim = false;
        break;
      case 23:
        style.italic = false;
        break;
      case 24:
        style.underline = false;
        break;
      case 38:
        style.fg = semicolon();
        break;
      case 39:
        style.fg = null;
        break;
      case 48:
        style.bg = semicolon();
        break;
      case 49:
        style.bg = null;
        break;
      case 58:
        semicolon();
        break;
      default:
        if (n === undefined) break;
        if (within(n, 30, 37)) style.fg = named(n - 30);
        else if (within(n, 40, 47)) style.bg = named(n - 40);
        else if (within(n, 90, 97)) style.fg = named(n - 90 + 8);
        else if (within(n, 100, 107)) style.bg = named(n - 100 + 8);
    }
  }
  return style;
}

/** `5:n`, `2:r:g:b`, or `2:space:r:g:b` with a colour space id. */
function colon(color: readonly number[]): AnsiColor | null {
  const [kind, ...rest] = color;
  if (kind === 5 && rest.length === 1 && rest[0] !== undefined) {
    return indexed(rest[0]);
  }
  if (kind !== 2 || (rest.length !== 3 && rest.length !== 4)) return null;
  const [r = 0, g = 0, b = 0] = rest.slice(-3);
  return rgb(r, g, b);
}

const SIXTEEN: readonly AnsiColor[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

/** anstyle-lossy 1.1's VGA palette, which Rust matches against. */
const VGA: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [170, 0, 0],
  [0, 170, 0],
  [170, 85, 0],
  [0, 0, 170],
  [170, 0, 170],
  [0, 170, 170],
  [170, 170, 170],
  [85, 85, 85],
  [255, 85, 85],
  [85, 255, 85],
  [255, 255, 85],
  [85, 85, 255],
  [255, 85, 255],
  [85, 255, 255],
  [255, 255, 255],
];

/** xterm's 6×6×6 cube's steps. */
const CUBE = [0, 95, 135, 175, 215, 255];

function named(index: number): AnsiColor {
  return SIXTEEN[index] ?? "black";
}

/** One of xterm's 256: the sixteen as they are, the cube and the greys as the nearest of the sixteen. */
function indexed(index: number): AnsiColor | null {
  if (index > 255) return null;
  if (index < 16) return named(index);
  if (index >= 232) {
    const grey = 8 + 10 * (index - 232);
    return rgb(grey, grey, grey);
  }
  const cube = index - 16;
  return rgb(
    CUBE[Math.floor(cube / 36)] ?? 0,
    CUBE[Math.floor(cube / 6) % 6] ?? 0,
    CUBE[cube % 6] ?? 0,
  );
}

/** The nearest of the sixteen by anstyle-lossy's weighted distance, the first of equals. */
function rgb(r: number, g: number, b: number): AnsiColor | null {
  if (r > 255 || g > 255 || b > 255) return null;
  let best = 0;
  let nearest = Infinity;
  VGA.forEach(([vr, vg, vb], index) => {
    const sum = r + vr;
    const distance =
      (2 * 512 + sum) * (r - vr) ** 2 +
      4 * (g - vg) ** 2 * 256 +
      (2 * 767 - sum) * (b - vb) ** 2;
    if (distance < nearest) {
      best = index;
      nearest = distance;
    }
  });
  return named(best);
}
