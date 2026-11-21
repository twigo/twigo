import type { KeybindingRule } from "../keybindings/resolver";
import type { Workbench } from "../services";

/** The commands quick access answers while open, as VS Code's `quickInput.*`; its footer shows their keys. */
export const QUICK_INPUT = {
  next: "quickInput.next",
  previous: "quickInput.previous",
  accept: "quickInput.accept",
  acceptToSide: "quickInput.acceptToSide",
  toggle: "quickInput.toggle",
} as const;

const CAN_PICK_MANY = "inQuickOpen && quickOpenCanPickMany";

/**
 * Quick access's keys are bindings the user may change. ↑, ↓ and Enter fire
 * in its input although they are bare, and so does Space where the open
 * provider takes ticked rows, and ⌃N and ⌃P move on macOS too (ARCHITECTURE
 * 5.2).
 */
export function registerQuickInputCommands(
  { commands, quickAccess }: Workbench,
  rules: KeybindingRule[],
): void {
  const all: readonly {
    id: string;
    title: string;
    key: string;
    /** A second key on macOS, bound before `key` so that the footer names `key`. */
    onMac?: string;
    enablement?: string;
    when?: string;
    run: () => void;
  }[] = [
    {
      id: QUICK_INPUT.next,
      title: "Select Next",
      key: "down",
      onMac: "ctrl+n",
      run: () => quickAccess.list?.move(1),
    },
    {
      id: QUICK_INPUT.previous,
      title: "Select Previous",
      key: "up",
      onMac: "ctrl+p",
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
    {
      id: QUICK_INPUT.toggle,
      title: "Toggle Selection",
      key: "space",
      enablement: CAN_PICK_MANY,
      when: CAN_PICK_MANY,
      run: () => quickAccess.list?.toggle(),
    },
  ];
  for (const { id, title, key, onMac, enablement, when, run } of all) {
    commands.register({
      id,
      title,
      category: "Quick Access",
      enablement: enablement ?? "inQuickOpen",
      run,
    });
    const holds = when ?? "inQuickOpen";
    if (onMac) {
      rules.push({
        key: onMac,
        command: id,
        when: `${holds} && platform == mac`,
      });
    }
    rules.push({ key, command: id, when: holds });
  }
}
