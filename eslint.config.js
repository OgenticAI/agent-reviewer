/**
 * Flat ESLint config (ESLint v9+) for the OgenticAI Reviewer.
 *
 * Type-aware linting is on. This codebase is almost entirely async I/O —
 * GitHub, Linear, and Anthropic calls — so the rules that need type
 * information (`no-floating-promises`, `no-misused-promises`, `await-thenable`)
 * are the ones that catch the bugs that actually bite here. The project is
 * small enough that the type-check cost is negligible.
 *
 * Sources are ESM TypeScript on Node 20; see tsconfig.json for the
 * corresponding compiler settings.
 */

import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },

  js.configs.recommended,

  // TypeScript sources and tests.
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // Turns off the core rules that TypeScript itself already enforces —
      // notably `no-redeclare`, which misreads the legal `const X` + `type X`
      // declaration merging that the Zod schemas in src/schema depend on.
      ...tsPlugin.configs["eslint-recommended"].overrides[0].rules,
      ...tsPlugin.configs["recommended-type-checked"].rules,

      // Unused vars: allow the conventional `_`-prefix escape hatch.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // `console` is the CLI's output channel — it is not a debugging leftover.
      "no-console": "off",
    },
  },

  // Tests exercise error paths and mock third-party shapes, so the strictness
  // that pays off in src/ mostly produces noise here.
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/unbound-method": "off",

      // Mocks implement async interfaces by returning canned values, so their
      // methods are `async` by contract without ever awaiting anything.
      "@typescript-eslint/require-await": "off",
    },
  },
];
