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
  // @todo: remove the roles switch once the owner has chosen at package 1's checkpoint
  {
    name: "roles",
    label: "Text Roles",
    choices: [
      {
        value: "accepted",
        about: "Dark text at lightness 0.96, 0.90, 0.75 and 0.65",
      },
      {
        value: "research",
        about:
          "Dark text at lightness 0.94, 0.87, 0.71 and 0.61, Lc 94, 80, 51 and 36 on the editor",
      },
    ],
  },
  // @todo: remove the smoothing switch once the owner has chosen at package 1's checkpoint
  {
    name: "smoothing",
    label: "Font Smoothing",
    choices: [
      {
        value: "rule",
        about: "Antialiased on the dark theme on macOS at 2x and above",
      },
      { value: "system", about: "The platform's own, everywhere" },
    ],
  },
];

/**
 * Sets `data-<name>` on the root for each switch: from the address in the
 * browser (`?variant=roles:research,smoothing:system`), else from the last
 * pick, else the default. A palette command picks one and keeps the pick in
 * `localStorage`.
 */
export function installVariants({ commands, quickAccess }: Workbench): void {
  const address = new URLSearchParams(location.search).get("variant") ?? "";
  for (const { name, label, choices } of SWITCHES) {
    const key = `variant.${name}`;
    const known = (value: string | null | undefined) =>
      choices.find((choice) => choice.value === value)?.value;
    let current =
      known(new RegExp(`(?:^|,)${name}:([^,]*)`).exec(address)?.[1]) ??
      known(localStorage.getItem(key)) ??
      choices[0].value;
    document.documentElement.dataset[name] = current;
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
            description: value === current ? `Current. ${about}` : about,
          })),
        );
        if (!picked) return;
        current = picked.id;
        document.documentElement.dataset[name] = current;
        localStorage.setItem(key, current);
      },
    });
  }
}
