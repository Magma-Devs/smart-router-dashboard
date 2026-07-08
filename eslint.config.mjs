// Flat ESLint config for the whole smart-router-dashboard monorepo.
// One config at the root covers every package (flat config's native model);
// per-area overrides live in the `files`-scoped blocks below.
//
// Deliberately NOT type-checked linting (no `projectService`) — it keeps the
// lint step fast and CI-portable without wiring a tsconfig project per package.
// `pnpm -r typecheck` already covers type correctness in the Quality Gate.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import nextPlugin from "@next/eslint-plugin-next";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  // Never lint build output, deps, or generated artifacts.
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "apps/web/next-env.d.ts",
      "pnpm-lock.yaml",
    ],
  },

  // Baseline for every TS/JS file in the repo.
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // Match the codebase's existing tolerance: prefix-to-ignore unused vars,
      // warn (don't error) on explicit `any` since the domain code uses a few
      // justified escapes, and let TS handle the rest.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-object-type": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  // Browser + React surface (apps/web).
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "@next/next": nextPlugin,
    },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      // The classic hooks rules stay hard errors...
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // ...but eslint-plugin-react-hooks v7 also ships the React-Compiler
      // strictness rules. They're valuable signal, yet they flag long-standing
      // patterns that predate linting here; surfacing them as warnings keeps CI
      // green while making the debt visible. Tighten to "error" as they're paid down.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/immutability": "warn",
    },
  },

  // Test + script files may reach for looser patterns.
  {
    files: ["**/__tests__/**", "**/*.test.{ts,tsx}", "**/scripts/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // Keep ESLint out of Prettier's lane — must be LAST so it can turn off
  // any stylistic rules the presets enabled.
  prettier,
);
