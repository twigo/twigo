import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import { importX } from "eslint-plugin-import-x";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
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

export default defineConfig(
  globalIgnores(["**/dist", "target", "apps/desktop/src-tauri"]),
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
      "import-x/resolver-next": [
        createTypeScriptImportResolver({
          project: ["apps/*/tsconfig.json", "packages/*/tsconfig.json"],
        }),
      ],
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
  prettier,
);
