import globals from "globals";
import tseslint from "typescript-eslint";
import eslintPluginImport from "eslint-plugin-import";

/** @type {import("eslint").Linter.FlatConfig[]} */
export default [
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    languageOptions: {
      globals: globals.node,
      parser: "@typescript-eslint/parser",
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      import: eslintPluginImport,
    },
    rules: {
      "import/extensions": ["error", "always"],
      "import/no-unresolved": "off",
    },
    settings: {
      "import/resolver": {
        node: {
          extensions: [".js", ".ts"],
        },
      },
    },
  },
  ...tseslint.configs.recommended,
];
