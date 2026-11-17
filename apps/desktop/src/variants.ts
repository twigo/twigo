import type { Workbench } from "@twigo/workbench";

interface Choice {
  readonly value: string;
  readonly about: string;
}

interface Switch {
  readonly name: string;
  readonly label: string;
  /** The first is the default. */
  readonly choices: readonly [Choice, ...Choice[]];
}

const SWITCHES: readonly Switch[] = [
  // @todo: remove the sash switch once the owner has chosen at package 3's checkpoint
  {
    name: "sash",
    label: "Sashes",
    choices: [
      {
        value: "subtle",
        about: "The side bars' and the panel's edge in --border-subtle",
      },
      {
        value: "line",
        about: "The side bars' and the panel's edge in --border",
      },
    ],
  },
];

const root = document.documentElement;
const address = new URLSearchParams(location.search).get("variant") ?? "";
const current = new Map<string, string>();

const known = (choices: readonly Choice[], value: string | null | undefined) =>
  choices.find((choice) => choice.value === value)?.value;

for (const { name, choices } of SWITCHES) {
  const value =
    known(choices, new RegExp(`(?:^|,)${name}:([^,]*)`).exec(address)?.[1]) ??
    known(choices, localStorage.getItem(`variant.${name}`)) ??
    choices[0].value;
  current.set(name, value);
  root.dataset[name] = value;
}

/**
 * Sets `data-<name>` on the root for each switch: from the address in the
 * browser (`?variant=sash:line`), else from the last pick, else the default.
 * A palette command picks one and keeps the pick in `localStorage`.
 */
export function installVariants({ commands, quickAccess }: Workbench): void {
  for (const { name, label, choices } of SWITCHES) {
    commands.register({
      id: `design.variant.${name}`,
      title: `${label}…`,
      category: "Design Variant",
      run: async () => {
        const picked = await quickAccess.pick(
          label,
          choices.map(({ value, about }) => ({
            id: value,
            label: value,
            description:
              value === current.get(name) ? `Current. ${about}` : about,
          })),
        );
        if (!picked) return;
        current.set(name, picked.id);
        root.dataset[name] = picked.id;
        localStorage.setItem(`variant.${name}`, picked.id);
      },
    });
  }
}
