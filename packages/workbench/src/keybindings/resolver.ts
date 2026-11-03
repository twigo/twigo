import {
  evaluate,
  parseWhen,
  type Lookup,
  type When,
} from "../contextkey/when";
import { parseKeys, type Chord, type Platform } from "./chord";
import { isBare, pressId, type KeyboardMapper, type Press } from "./mapper";

/** Lowest first: a later source overrides an earlier one (ARCHITECTURE 5.2). */
export const WEIGHTS = ["core", "builtin", "extension", "user"] as const;
export type Weight = (typeof WEIGHTS)[number];

/** A binding as contributions and `keybindings.json` write it. */
export interface KeybindingRule {
  /** Chords separated by spaces: `mod+k mod+s`. */
  readonly key: string;
  readonly mac?: string;
  readonly linux?: string;
  readonly win?: string;
  readonly command: string;
  readonly args?: unknown;
  readonly when?: string;
}

/** A user rule that removes defaults: `-command`, narrowed by `key` and `when`. */
export interface KeybindingRemoval {
  readonly key?: string;
  readonly command: `-${string}`;
  readonly when?: string;
}

export interface Binding {
  readonly presses: readonly [Press, ...Press[]];
  /** The rule's chords before the layout, as a native menu names them. */
  readonly chords: readonly [Chord, ...Chord[]];
  /** The presses as `pressId` gives them. */
  readonly ids: readonly string[];
  readonly command: string;
  readonly args: unknown;
  readonly when: When | undefined;
  readonly whenSource: string | undefined;
  readonly weight: Weight;
}

export type Resolution =
  | { readonly kind: "none" }
  | { readonly kind: "chord" }
  | { readonly kind: "command"; readonly binding: Binding };

export interface Source {
  readonly weight: Weight;
  readonly rules: readonly (KeybindingRule | KeybindingRemoval)[];
}

const LIST_ONLY = parseWhen("listFocus && !inputFocus");
const QUICK_OPEN = parseWhen("inQuickOpen");
/** Bare keys that edit no line of text, so they drive quick access's list from its input. */
const QUICK_OPEN_KEYS = new Set(["ArrowUp", "ArrowDown", "Enter"]);

/**
 * Resolution as in VS Code's keybindingResolver (1.144.0): rules sorted by
 * weight, removals applied, and the last rule whose `when` holds wins. If
 * that rule needs more chords, the resolver waits for them.
 */
export class Resolver {
  readonly #bindings: readonly Binding[];
  readonly #byFirst = new Map<string, Binding[]>();

  constructor(sources: readonly Source[], mapper: KeyboardMapper) {
    const ordered = [...sources].sort(
      (a, b) => WEIGHTS.indexOf(a.weight) - WEIGHTS.indexOf(b.weight),
    );
    const bindings: Binding[] = [];
    const removals: {
      removal: KeybindingRemoval;
      presses?: readonly string[];
    }[] = [];
    for (const { weight, rules } of ordered) {
      for (const rule of rules) {
        if (isRemoval(rule)) {
          if (rule.key === undefined) {
            removals.push({ removal: rule });
            continue;
          }
          const presses = pressesOf(
            parseKeys(rule.key, mapper.platform),
            mapper,
          );
          if (presses)
            removals.push({ removal: rule, presses: presses.map(pressId) });
          continue;
        }
        const chords = parseKeys(
          platformKey(rule, mapper.platform),
          mapper.platform,
        );
        const presses = pressesOf(chords, mapper);
        if (!presses) continue;
        bindings.push({
          presses,
          chords,
          ids: presses.map(pressId),
          command: rule.command,
          args: rule.args,
          when: rule.when === undefined ? undefined : parseWhen(rule.when),
          whenSource:
            rule.when === undefined ? undefined : normalize(rule.when),
          weight,
        });
      }
    }
    this.#bindings = bindings.filter(
      (binding) =>
        binding.weight === "user" ||
        !removals.some(({ removal, presses }) =>
          removes(removal, presses, binding),
        ),
    );
    for (const binding of this.#bindings) {
      const first = pressId(binding.presses[0]);
      const list = this.#byFirst.get(first) ?? [];
      list.push(binding);
      this.#byFirst.set(first, list);
    }
  }

  /**
   * `pending` holds the chords pressed so far; `holds` tells whether a
   * binding may fire, given its command's enablement.
   */
  resolve(
    pending: readonly Press[],
    press: Press,
    lookup: Lookup,
    holds: (binding: Binding) => boolean,
  ): Resolution {
    const pressed = [...pending, press].map(pressId);
    const candidates = this.#byFirst.get(pressId(pending[0] ?? press)) ?? [];
    for (const binding of [...candidates].reverse()) {
      if (binding.ids.length < pressed.length) continue;
      if (pressed.some((id, at) => id !== binding.ids[at])) continue;
      if (binding.when && !evaluate(binding.when, lookup)) continue;
      if (isBare(binding.presses[0]) && !bareFires(binding.presses[0], lookup))
        continue;
      if (!holds(binding)) continue;
      return binding.ids.length > pressed.length
        ? { kind: "chord" }
        : { kind: "command", binding };
    }
    return { kind: "none" };
  }

  /** The bindings of a command, the one that wins first. */
  bindingsOf(command: string): Binding[] {
    return this.#bindings
      .filter((binding) => binding.command === command)
      .reverse();
  }
}

/** Bare keys fire in a focused list, and ↑, ↓ and Enter in quick access too (ARCHITECTURE 5.2). */
function bareFires(press: Press, lookup: Lookup): boolean {
  return (
    evaluate(LIST_ONLY, lookup) ||
    (QUICK_OPEN_KEYS.has(pressId(press)) && evaluate(QUICK_OPEN, lookup))
  );
}

function isRemoval(
  rule: KeybindingRule | KeybindingRemoval,
): rule is KeybindingRemoval {
  return rule.command.startsWith("-");
}

function platformKey(rule: KeybindingRule, platform: Platform): string {
  return rule[platform] ?? rule.key;
}

/** Undefined where the layout has no key for a character of the binding. */
function pressesOf(
  chords: readonly [Chord, ...Chord[]],
  mapper: KeyboardMapper,
): readonly [Press, ...Press[]] | undefined {
  const [first, ...rest] = chords.map((chord) => mapper.press(chord));
  const mapped = rest.filter((press) => press !== undefined);
  if (!first || mapped.length !== rest.length) return undefined;
  return [first, ...mapped];
}

/** Throws on a rule whose keys or `when` do not parse, on any layout. */
export function validate(
  rule: KeybindingRule | KeybindingRemoval,
  platform: Platform,
): void {
  if (rule.when !== undefined) parseWhen(rule.when);
  if (isRemoval(rule)) {
    if (rule.key !== undefined) parseKeys(rule.key, platform);
    return;
  }
  parseKeys(platformKey(rule, platform), platform);
}

function normalize(when: string): string {
  return when.replace(/\s+/g, "");
}

/**
 * A removal drops the lower-weight bindings of its command, narrowed to its
 * keys and to an identical `when` when it gives them.
 */
function removes(
  removal: KeybindingRemoval,
  presses: readonly string[] | undefined,
  binding: Binding,
): boolean {
  if (removal.command.slice(1) !== binding.command) return false;
  if (presses) {
    const { ids } = binding;
    if (ids.length !== presses.length) return false;
    if (ids.some((id, at) => id !== presses[at])) return false;
  }
  return (
    removal.when === undefined || normalize(removal.when) === binding.whenSource
  );
}
