import type { KeybindingRule } from "../keybindings/resolver";
import type { Workbench } from "../services";

/** The commands quick access answers while open, as VS Code's `quickInput.*`; its footer shows their keys. */
export const QUICK_INPUT = {
  next: "quickInput.next",
  previous: "quickInput.previous",
  accept: "quickInput.accept",
  acceptToSide: "quickInput.acceptToSide",
} as const;

/**
 * Quick access's keys are bindings the user may change. ↑, ↓ and Enter fire
 * in its input although they are bare (ARCHITECTURE 5.2).
 */
export function registerQuickInputCommands(
  { commands, quickAccess }: Workbench,
  rules: KeybindingRule[],
): void {
  const all: readonly {
    id: string;
    title: string;
    key: string;
    enablement?: string;
    run: () => void;
  }[] = [
    {
      id: QUICK_INPUT.next,
      title: "Select Next",
      key: "down",
      run: () => quickAccess.list?.move(1),
    },
    {
      id: QUICK_INPUT.previous,
      title: "Select Previous",
      key: "up",
      run: () => quickAccess.list?.move(-1),
    },
    {
      id: QUICK_INPUT.accept,
      title: "Accept",
      key: "enter",
      run: () => quickAccess.list?.accept({ side: false }),
    },
    {
      id: QUICK_INPUT.acceptToSide,
      title: "Open to the Side",
      key: "mod+enter",
      enablement: "inQuickOpen && quickOpenToSide",
      run: () => quickAccess.list?.accept({ side: true }),
    },
  ];
  for (const { id, title, key, enablement, run } of all) {
    commands.register({
      id,
      title,
      category: "Quick Access",
      enablement: enablement ?? "inQuickOpen",
      run,
    });
    rules.push({ key, command: id, when: "inQuickOpen" });
  }
}
