// ESLint flat config (OGE-2451).
//
// This repo carried `"lint": "eslint src tests"` and the eslint dependencies
// from the beginning, with no config file — so the script failed on every
// branch and always had. A green PR check named `lint` came from the
// UAT-checklist workflow, which is a different thing entirely and never fails.
// The name provided assurance the repo had never earned.
//
// ── Why type-aware ──────────────────────────────────────────────────────────
//
// Without type information a linter sees syntax only: it can find an unused
// variable, but not a dropped `await`. `projectService` gives the rules the
// same type graph `tsc` builds, which is what makes `no-floating-promises` and
// `no-misused-promises` possible.
//
// Those are worth the slower run here specifically. A dropped promise in the
// render chain fails silently and leaves no stack trace — the exact class of
// defect this codebase is built to find in other people's code, and the class
// that survived 1,000 passing tests in `computeCoverage` (OGE-2432).
//
// ── Why so few style rules ──────────────────────────────────────────────────
//
// Prettier owns formatting (`npm run format`). A linter that argues about
// quotes trains people to skim its output, and a linter people skim is worse
// than no linter, because the check stays green in their heads.

import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "work/**", "*.subject.json"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      ecmaVersion: 2022,
      sourceType: "module",
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs["eslint-recommended"].overrides[0].rules,
      ...tsPlugin.configs.recommended.rules,

      // The rules this config exists for. A dropped promise is a silent
      // failure, which is the one failure mode we cannot afford to ship.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",

      // `catch {}` that swallows the error is how a wrong answer becomes a
      // confident one. Empty blocks elsewhere are usually fine.
      "no-empty": ["error", { allowEmptyCatch: false }],

      // An underscore prefix is the deliberate "I know, and I mean it" marker.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],

      // `any` is sometimes the honest type at a JSON boundary. Flag it so the
      // choice is visible in review, but do not fail the build over it.
      "@typescript-eslint/no-explicit-any": "warn",

      // TypeScript already proves these, and the base rules produce false
      // positives on overloads and enums.
      "no-undef": "off",
      "no-redeclare": "off",
      "no-unused-vars": "off",
    },
  },
  {
    // Tests deliberately construct malformed input to prove the guards fire,
    // so a hand-written wrong-shaped object is the point rather than a slip.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    // Config and scripts are plain JS, with no project to type against.
    files: ["*.mjs", "scripts/**/*.mjs", "scripts/**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
  },
];
