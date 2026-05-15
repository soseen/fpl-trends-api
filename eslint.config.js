import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    files: ["src/**/*.ts"],
  },
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintConfigPrettier,
  {
    rules: {
      /* TypeScript strictness */
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],

      /* Valuable type-checked rules (keep) */
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "warn",

      /*
       * Disable overly aggressive no-unsafe-* rules.
       * These flag every JSON.parse() result and dynamic Prisma call.
       * The codebase relies heavily on JSON.parse for FPL API data
       * and Prisma operations that can't be fully statically typed.
       */
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",

      /* General quality */
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
      "no-duplicate-imports": "error",
      "no-template-curly-in-string": "warn",
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    ignores: ["dist/", "node_modules/", "prisma/", "src/data/"],
  },
];
