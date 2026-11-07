import { Palette } from "lucide-react";
import type { ContextColor } from "@twigo/protocol";
import { createElement } from "react";
import { ContextSwatch } from "../parts/ContextSwatch";
import type { QuickPickItem } from "../quickaccess/registry";
import type { Workbench } from "../services";
import { CONTEXT_COLORS } from "./colors";

export const SET_SPACE_COLOR = "workbench.action.setSpaceColor";

const AUTOMATIC = "automatic";

/**
 * Picks the colour of a space's context (ARCHITECTURE 4.2): the space the
 * rail's menu names, while the rail shows it, or the active one when none
 * is named. A colour from the kubeconfig stays, and the pick says so.
 */
export function registerSpaceColor({
  commands,
  menus,
  spaces,
  colors,
  quickAccess,
}: Workbench): void {
  commands.register({
    id: SET_SPACE_COLOR,
    title: "Set Space Colour…",
    category: "Space",
    icon: Palette,
    enablement: "space.count > 0",
    run: async (args) => {
      const space =
        typeof args === "string"
          ? spaces.list.find((candidate) => candidate.id === args)
          : spaces.active;
      const [context, ...more] = space?.contexts ?? [];
      if (!space || context === undefined || more.length > 0) return;
      const current = colors.of(context);
      const source = colors.source(context);
      const items: QuickPickItem[] = [
        ...CONTEXT_COLORS.map((color) => ({
          id: color,
          label: title(color),
          icon: ({ className }: { className?: string }) =>
            createElement(ContextSwatch, { color, className }),
          ...(color === current && { description: describe(source) }),
        })),
        {
          id: AUTOMATIC,
          label: "Automatic",
          description: "From its environment type, else its name",
        },
      ];
      const picked = await quickAccess.pick(
        source === "kubeconfig"
          ? `${context}'s kubeconfig sets its colour, which a pick here cannot change`
          : `Colour of ${space.name}`,
        items,
      );
      if (!picked || source === "kubeconfig") return;
      colors.choose(
        context,
        picked.id === AUTOMATIC ? undefined : (picked.id as ContextColor),
      );
    },
  });
  menus.append("space/context", { command: SET_SPACE_COLOR, group: "1_space" });
}

function title(color: ContextColor): string {
  return color.charAt(0).toUpperCase() + color.slice(1);
}

function describe(source: string): string {
  if (source === "kubeconfig") return "Current, from the kubeconfig";
  if (source === "chosen") return "Current";
  if (source === "environment") return "Current, from its environment type";
  return "Current, from the context's name";
}
