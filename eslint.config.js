import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import importPlugin from "eslint-plugin-import";
import prettier from "eslint-config-prettier";

// Stores the workbench shell legitimately owns. Everything else under @/store/*
// is domain state and is denied by default (below), so a new domain (or a new
// store like compare/readonly) can't leak into the shell without an explicit
// allow here.
const SHELL_STORES = [
  "ui",
  "palette",
  "help",
  "toasts",
  "zoom",
  "commandHistory",
];
// Domain state/logic the workbench shell must never reach into - it talks to
// NATS only through the shell registries (src/shell/*) that the module fills.
// Deny-by-default: ban all of @/store/* and re-include the shell stores. Negated
// patterns must come last (gitignore semantics). @/lib/editor is the NATS editor
// opens; the shell uses the generic pane ops from @/shell/editorHost instead.
const DOMAIN_STATE = [
  "@/store/*",
  "@/store/**",
  "@/modules/*",
  "@/modules/**",
  "@/lib/api",
  "@/lib/actions",
  "@/lib/editor",
  ...SHELL_STORES.map((s) => `!@/store/${s}`),
];
// Domain view/editor components. The shell renders these only through the
// registries; AppShell is the one allowed exception (it composes the panes).
const DOMAIN_UI = [
  "@/components/views/*",
  "@/components/views/**",
  "@/components/editor/*",
  "@/components/editor/**",
];
const SHELL_BOUNDARY_MSG =
  "Workbench shell stays domain-free: contribute through a shell registry (src/shell/*) or use a shell store (ui/palette/help/toasts/zoom/commandHistory) - don't import NATS state, modules, views, editors or IPC (use @/shell/editorHost for pane ops).";

export default tseslint.config(
  { ignores: ["**/dist", "**/src-tauri", "**/node_modules"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
      reactHooks.configs.flat["recommended-latest"],
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-refresh": reactRefresh,
      import: importPlugin,
    },
    settings: {
      "import/resolver": {
        typescript: {
          alwaysTryTypes: true,
          project: ["apps/*/tsconfig.json", "libs/*/tsconfig.json"],
        },
      },
    },
    rules: {
      "import/no-cycle": ["error", { ignoreExternal: true }],
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        { ignoreArrowShorthand: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          ignoreRestSiblings: true,
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
    },
  },
  {
    files: ["**/components/ui/**/*.tsx", "libs/ui/**/*.tsx"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  {
    files: ["**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  // Shell/domain boundary (#23): the workbench shell and the contribution
  // registries must not import NATS state, modules, views, editors or IPC -
  // they talk to the domain only through the registries the module fills.
  {
    files: [
      "apps/twigo/src/components/workbench/**/*.{ts,tsx}",
      "apps/twigo/src/shell/**/*.{ts,tsx}",
      // Shell infra that lives under lib/ but is domain-free (the command
      // registry + dispatch). Covered here so the boundary actually holds.
      "apps/twigo/src/lib/commands.ts",
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [...DOMAIN_STATE, ...DOMAIN_UI],
              message: SHELL_BOUNDARY_MSG,
            },
          ],
        },
      ],
    },
  },
  // AppShell is the workbench composition root: it may assemble the pane
  // components, but still must not reach into domain state/modules/IPC.
  {
    files: ["apps/twigo/src/components/workbench/AppShell.tsx"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: DOMAIN_STATE,
              message:
                "AppShell composes the shell panes but must not reach into NATS state, modules or IPC.",
            },
          ],
        },
      ],
    },
  },
  prettier,
);
