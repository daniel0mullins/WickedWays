import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Generated output and dependencies are never linted.
  {
    ignores: ["**/dist/", "**/coverage/", "**/node_modules/", "docs-site/", "**/pkg/", "generated/"],
  },

  // Baseline JS rules apply to every file (including this config).
  js.configs.recommended,

  // Type-aware linting, scoped to TypeScript sources so the parser never tries
  // to pull type info for plain-JS files like this config.
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        // Resolve each file's tsconfig automatically.
        projectService: {
          // vitest.config.ts lives outside src/ so it can't be included in the
          // main tsconfig (rootDir: ./src). Allow it to be type-checked against
          // a default project so ESLint doesn't reject it outright.
          allowDefaultProject: ["vitest.config.ts", "vitest.setup.ts", "packages/client/vite.config.ts", "packages/play/vite.config.ts", "packages/play/playwright.config.ts", "packages/play/e2e/*.spec.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow intentionally-unused args/vars when prefixed with an underscore
      // (matches the `set occupants(_)` style already used in the codebase).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // The character "action map" deliberately passes method references around
      // as identity keys (isActionMap / recordAction); they are used as tokens,
      // never detached and invoked, so this check does not apply here.
      "@typescript-eslint/unbound-method": "off",
    },
  },

  // Tests (and the shared test helpers) lean on `as unknown as X` stubs and
  // mock objects by design, so the strict "unsafe any" checks are relaxed here
  // to avoid noise. vitest.setup.ts patches Node globals (process.emitWarning)
  // which the default-project tsconfig doesn't resolve, so the same relaxation
  // applies there.
  {
    files: ["**/*.test.ts", "src/test-utils.ts", "vitest.setup.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },

  // Playwright config and E2E specs live outside any package tsconfig so they
  // run under the default project; relax the no-unsafe-member-access rule
  // (process.env access) for config-level files that cannot be fully resolved.
  {
    files: ["packages/play/playwright.config.ts", "packages/play/e2e/*.spec.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
);
