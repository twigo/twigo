import css from "@eslint/css";
import js from "@eslint/js";
import colorNames from "color-name";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import { importX } from "eslint-plugin-import-x";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tailwindColors from "tailwindcss/colors";
import tseslint from "typescript-eslint";

// The Twigo packages each package may import (docs/ARCHITECTURE.md, 2.3).
const MAY_IMPORT = {
  ui: ["utils"],
  workbench: ["ui", "protocol", "utils"],
  kube: ["ui", "workbench", "protocol", "utils"],
  protocol: ["utils"],
  utils: [],
};

const boundaries = Object.entries(MAY_IMPORT).flatMap(([pkg, allowed]) => {
  const denied = Object.keys(MAY_IMPORT).filter(
    (other) => other !== pkg && !allowed.includes(other),
  );
  if (denied.length === 0) return [];
  const may =
    allowed.length === 0
      ? "no other Twigo package"
      : allowed.map((other) => `@twigo/${other}`).join(", ");
  return {
    files: [`packages/${pkg}/**/*.{ts,tsx}`],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: denied.flatMap((other) => [
                `@twigo/${other}`,
                `@twigo/${other}/*`,
              ]),
              message: `packages/${pkg} may import ${may} (docs/ARCHITECTURE.md, 2.3).`,
            },
          ],
        },
      ],
    },
  };
});

const TOKENS_ONLY =
  "Use a token from packages/ui instead of a raw colour (docs/ARCHITECTURE.md, 4.9).";
const COLOUR_FUNCTION = "rgba?|hsla?|hwb|lab|lch|oklab|oklch|color";
const PALETTE = Object.keys(tailwindColors)
  .filter((name) => !["inherit", "current", "transparent"].includes(name))
  .join("|");
const UTILITY =
  "bg|text|border(-[trblxyse])?|outline|ring(-offset)?|fill|stroke|from|via|to|decoration|divide|accent|caret|shadow|placeholder";
const RAW_IN_TEXT = `/#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\\b|\\b(${COLOUR_FUNCTION})\\(|\\b(${UTILITY})-(${PALETTE})\\b/i`;

const tokensOnly = [
  {
    files: ["**/*.{ts,tsx}"],
    ignores: ["packages/ui/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: `Literal[value=${RAW_IN_TEXT}]`, message: TOKENS_ONLY },
        {
          selector: `TemplateElement[value.raw=${RAW_IN_TEXT}]`,
          message: TOKENS_ONLY,
        },
      ],
    },
  },
  {
    files: ["**/*.css"],
    ignores: ["packages/ui/**"],
    plugins: { css },
    language: "css/css",
    languageOptions: { tolerant: true },
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "Hash", message: TOKENS_ONLY },
        {
          selector: `Function[name=/^(${COLOUR_FUNCTION})$/i]`,
          message: TOKENS_ONLY,
        },
        {
          selector: `Declaration Identifier[name=/^(${Object.keys(colorNames).join("|")})$/i]`,
          message: TOKENS_ONLY,
        },
      ],
    },
  },
];

export default defineConfig(
  globalIgnores(["**/dist", "target", "packages/protocol/src/generated.ts"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      reactHooks.configs.flat["recommended-latest"],
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "import-x": importX,
      "react-refresh": reactRefresh,
    },
    settings: {
      "import-x/resolver-next": [createTypeScriptImportResolver()],
    },
    rules: {
      "import-x/no-cycle": ["error", { ignoreExternal: true }],
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
  boundaries,
  tokensOnly,
  prettier,
);
