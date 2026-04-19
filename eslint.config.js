import js from "@eslint/js";
import prettierOff from "eslint-config-prettier";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import importX from "eslint-plugin-import-x";
import regexp from "eslint-plugin-regexp";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", ".bun/**", "*.tsbuildinfo", "bin/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      "import-x/resolver-next": [
        createTypeScriptImportResolver({
          alwaysTryTypes: true,
          noWarnOnMultipleProjects: true,
          project: ["./tsconfig.json", "./tsconfig.test.json"],
        }),
      ],
    },
    plugins: {
      "import-x": importX,
      regexp,
      security,
    },
    rules: {
      ...importX.flatConfigs.recommended.rules,
      ...importX.flatConfigs.typescript.rules,
      ...regexp.configs["flat/recommended"].rules,
      ...security.configs.recommended.rules,

      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "import-x/no-default-export": "error",
      "import-x/order": [
        "error",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index", "type"],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ThrowStatement > NewExpression[callee.name='Error']",
          message:
            "Use a typed error class from src/core/errors. See CLAUDE.md § Typed errors only.",
        },
      ],
    },
  },
  {
    files: ["eslint.config.js"],
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "import-x/no-default-export": "off",
    },
  },
  {
    files: ["tests/**/*.ts", "tests/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
  prettierOff,
);
