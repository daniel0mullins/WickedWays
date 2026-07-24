import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Generated output and dependencies are never linted.
  {
    ignores: [
      "**/dist/",
      "**/coverage/",
      "**/node_modules/",
      "docs-site/",
      "**/pkg/",
      // ts-rs stray output from a bare `cargo test` (gitignored; see .gitignore).
      "crates/wickedways-core/bindings/",
      // wasm-pack build artifacts (gitignored). `**/pkg/` does NOT match these.
      "**/pkg-node/",
      "**/pkg-web/",
      // Generated TS bindings (already gitignore-adjacent; covers generated/bindings/).
      "generated/",
      // The Rust crates are not part of the TS project; their only JS is ad-hoc
      // dev harnesses (e.g. crates/wickedways-web/e2e/*.mjs) with node/browser
      // globals, not linted here.
      "crates/**",
    ],
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
          allowDefaultProject: ["vitest.config.ts", "vitest.setup.ts", "packages/client/vite.config.ts"],
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


  // Node CLI scripts run under js.configs.recommended, which declares no globals,
  // so `console`/`process`/`Buffer` trip no-undef. Declare the Node globals for
  // them. This only ADDS names — it never relaxes a rule, so real source is
  // unaffected. (eslint.config.mjs itself needs no globals and is unchanged.)
  {
    files: ["scripts/**/*.{js,mjs,cjs}"],
    languageOptions: { globals: { ...globals.node } },
  },

  // The conformance harness casts raw strings to branded ids (`as ItemId`,
  // `as CharacterId`) and narrows `unknown` with `as Record<string, unknown>` as
  // an intentional pattern; the type-aware rule flags them as unnecessary. This
  // scoped override is the only way to green conformance/canonical-json.ts
  // (edit-forbidden — the differential-gate authority) without touching it, and
  // it keeps the rule active for real src/ + packages/ source.
  {
    files: ["conformance/**/*.ts"],
    rules: { "@typescript-eslint/no-unnecessary-type-assertion": "off" },
  },
);
