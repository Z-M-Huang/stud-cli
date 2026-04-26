import js from "@eslint/js";
import prettierOff from "eslint-config-prettier";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import importX from "eslint-plugin-import-x";
import regexp from "eslint-plugin-regexp";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Fixture files are intentional test data — some contain patterns that would
    // fail lint rules by design (e.g., banned-vocab fixtures). Exclude them.
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      ".bun/**",
      "*.tsbuildinfo",
      "bin/**",
      "tests/fixtures/**",
      "src-build/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // scripts/ and all tests/ subdirectories are in tsconfig.test.json but
          // TypeScript's project service resolves by "closest tsconfig" (tsconfig.json,
          // src-only). Glob patterns allow a default project for those files.
          allowDefaultProject: [
            "eslint.config.js",
            "scripts/*.ts",
            "tests/scripts/*.ts",
            "tests/wiki/*.ts",
            "tests/ci/*.ts",
            "tests/cli/*.ts",
            // tests/core/<category>/*.ts — added as new test directories land.
            "tests/core/errors/*.ts",
            // tests/core/env/*.ts — Unit 45: Env Provider tests.
            "tests/core/env/*.ts",
            // tests/core/events/*.ts — Unit 27: Event Bus tests.
            "tests/core/events/*.ts",
            // tests/core/host/*.ts — Unit 4: HostAPI shape tests.
            "tests/core/host/*.ts",
            // tests/core/host/impl/*.ts — Unit 39: host impl wrapper tests.
            "tests/core/host/impl/*.ts",
            // tests/core/concurrency/*.ts — Unit 38: scope tree and serializer tests.
            "tests/core/concurrency/*.ts",
            // tests/core/session/*.ts — Unit 41: SessionManifest tests.
            "tests/core/session/*.ts",
            // tests/core/session-lifecycle/*.ts — Unit 42: SessionStateMachine tests.
            "tests/core/session-lifecycle/*.ts",
            // tests/core/execution-model/*.ts — Unit 29: ExecutionInvariants tests.
            "tests/core/execution-model/*.ts",
            // tests/core/loop/*.ts — Unit 30: MessageLoop orchestrator tests.
            "tests/core/loop/*.ts",
            // tests/core/loop/stages/*.ts — Unit 31+: per-stage handler tests.
            "tests/core/loop/stages/*.ts",
            // tests/core/sm/*.ts — Unit 81: stage execution orchestrator tests.
            "tests/core/sm/*.ts",
            // tests/core/persistence/*.ts — Unit 43: snapshot writer and crash recovery tests.
            "tests/core/persistence/*.ts",
            // tests/core/config/*.ts — Unit 46: configuration scope resolver tests.
            "tests/core/config/*.ts",
            // tests/core/settings/*.ts — Unit 47: Settings shape validator and merge tests.
            "tests/core/settings/*.ts",
            // tests/core/security/secrets-hygiene/*.ts — Unit 48: secrets-hygiene guard tests.
            "tests/core/security/secrets-hygiene/*.ts",
            // tests/core/security/trust/*.ts — Unit 51: trust store tests.
            "tests/core/security/trust/*.ts",
            // tests/core/security/modes/*.ts — Unit 52: security-modes resolver tests.
            "tests/core/security/modes/*.ts",
            // tests/core/security/approval/*.ts — Unit 54: approval-key derivation tests.
            "tests/core/security/approval/*.ts",
            // tests/core/project/*.ts — Unit 49: project-root resolver tests.
            "tests/core/project/*.ts",
            // tests/core/interaction/*.ts — Unit 57: Interaction Protocol core tests.
            "tests/core/interaction/*.ts",
            // tests/core/commands/*.ts — Unit 61: Command dispatcher tests.
            "tests/core/commands/*.ts",
            // tests/core/prompts/*.ts — Unit 63: prompt registry tests.
            "tests/core/prompts/*.ts",
            // tests/core/resources/*.ts — Unit 64: resource registry tests.
            "tests/core/resources/*.ts",
            // tests/core/context/*.ts — Unit 65: context assembly tests.
            "tests/core/context/*.ts",
            // tests/core/capabilities/*.ts — Unit 88: capability negotiator runtime tests.
            "tests/core/capabilities/*.ts",
            // tests/core/hooks/*.ts — Unit 69: hook taxonomy tests.
            "tests/core/hooks/*.ts",
            // tests/core/lifecycle/*.ts — Unit 72: lifecycle manager tests.
            "tests/core/lifecycle/*.ts",
            // tests/core/discovery/*.ts — Unit 73: extension discovery tests.
            "tests/core/discovery/*.ts",
            // tests/core/install/*.ts — Unit 77: extension installation tests.
            "tests/core/install/*.ts",
            // tests/core/integrity/*.ts — Unit 79: extension integrity verifier tests.
            "tests/core/integrity/*.ts",
            // tests/core/mcp/*.ts — Unit 89: MCP client and server registry tests.
            "tests/core/mcp/*.ts",
            // tests/core/network/*.ts — Unit 98: network policy tests.
            "tests/core/network/*.ts",
            // tests/core/platform/*.ts — Unit 99: platform path and env tests.
            "tests/core/platform/*.ts",
            // tests/core/observability/*.ts — Unit 93: observability bus tests.
            "tests/core/observability/*.ts",
            // tests/core/diagnostics/*.ts — Unit 95: health probe diagnostics tests.
            "tests/core/diagnostics/*.ts",
            // tests/core/extension-isolation/*.ts — Unit 101: extension isolation assertion tests.
            "tests/core/extension-isolation/*.ts",
            // tests/core/extension-isolation/fixtures/*/*.ts — Unit 101 fixture source files.
            "tests/core/extension-isolation/fixtures/*/*.ts",
            // tests/core/extension-isolation/fixtures/*/tests/*.ts — Unit 101 skipped test-only mention fixture.
            "tests/core/extension-isolation/fixtures/*/tests/*.ts",
            // tests/runtime/*.ts — Unit 100: determinism runtime tests.
            "tests/runtime/*.ts",
            // tests/contracts/*.ts — Unit 3: meta-contract shape tests.
            "tests/contracts/*.ts",
            // tests/helpers/*.ts — Unit 5: mock host and fixture helpers.
            "tests/helpers/*.ts",
            // tests/extensions/providers/_adapter/*.ts — Unit 104: protocol adapter tests.
            "tests/extensions/providers/_adapter/*.ts",
            // tests/extensions/providers/_shared/*.ts — Unit 109: shared provider capability tests.
            "tests/extensions/providers/_shared/*.ts",
            // tests/extensions/providers/anthropic/*.ts — Unit 106: Anthropic provider tests.
            "tests/extensions/providers/anthropic/*.ts",
            // tests/extensions/providers/openai-compatible/*.ts — Unit 107: OpenAI provider tests.
            "tests/extensions/providers/openai-compatible/*.ts",
            // tests/extensions/providers/gemini/*.ts — Unit 108: Gemini provider tests.
            "tests/extensions/providers/gemini/*.ts",
            // tests/extensions/providers/cli-wrapper/*.ts — Unit 112: CLI wrapper provider tests.
            "tests/extensions/providers/cli-wrapper/*.ts",
            // tests/extensions/session-stores/filesystem/*.ts — Unit 110: Filesystem store tests.
            "tests/extensions/session-stores/filesystem/*.ts",
            // tests/extensions/ui/default-tui/*.ts — Unit 111: Default TUI tests.
            "tests/extensions/ui/default-tui/*.ts",
            // tests/extensions/loggers/file/*.ts — Unit 113: file logger tests.
            "tests/extensions/loggers/file/*.ts",
            // tests/extensions/context-providers/system-prompt-file/*.ts — Unit 114: system-prompt-file context provider tests.
            "tests/extensions/context-providers/system-prompt-file/*.ts",
            // tests/extensions/hooks/guard-example/*.ts — Unit 115: guard-example reference hook tests.
            "tests/extensions/hooks/guard-example/*.ts",
            // tests/extensions/hooks/observer-example/*.ts — Unit 116: observer-example reference hook tests.
            "tests/extensions/hooks/observer-example/*.ts",
            // tests/extensions/hooks/transform-example/*.ts — Unit 117: transform-example reference hook tests.
            "tests/extensions/hooks/transform-example/*.ts",
            // tests/extensions/commands/bundled/help/*.ts — Unit 118: /help bundled command tests.
            "tests/extensions/commands/bundled/help/*.ts",
            // tests/extensions/commands/bundled/save-and-close/*.ts — Unit 119: /save-and-close bundled command tests.
            "tests/extensions/commands/bundled/save-and-close/*.ts",
            // tests/extensions/commands/bundled/trust/*.ts — Unit 120: /trust bundled command tests.
            "tests/extensions/commands/bundled/trust/*.ts",
            // tests/extensions/commands/bundled/mode/*.ts — Unit 121: /mode bundled command tests.
            "tests/extensions/commands/bundled/mode/*.ts",
            // tests/extensions/commands/bundled/health/*.ts — Unit 122: /health bundled command tests.
            "tests/extensions/commands/bundled/health/*.ts",
            // tests/extensions/commands/bundled/network-policy/*.ts — Unit 123: /network-policy bundled command tests.
            "tests/extensions/commands/bundled/network-policy/*.ts",
            // tests/extensions/tools/ask-user/*.ts — Unit 124: ask-user reference tool tests.
            "tests/extensions/tools/ask-user/*.ts",
            // tests/extensions/tools/bash/*.ts — Unit 125: bash reference tool tests.
            "tests/extensions/tools/bash/*.ts",
            // tests/extensions/tools/catalog/*.ts — Unit 126: catalog reference tool tests.
            "tests/extensions/tools/catalog/*.ts",
            // tests/extensions/tools/context-compaction/*.ts — Unit 127: context-compaction reference tool tests.
            "tests/extensions/tools/context-compaction/*.ts",
            // tests/extensions/tools/edit/*.ts — Unit 128: edit reference tool tests.
            "tests/extensions/tools/edit/*.ts",
            // tests/extensions/tools/simple-tools/read/*.ts — Unit 129: simple-tools read tests.
            "tests/extensions/tools/simple-tools/read/*.ts",
            // tests/extensions/tools/simple-tools/write/*.ts — Unit 130: simple-tools write tests.
            "tests/extensions/tools/simple-tools/write/*.ts",
            // tests/extensions/tools/simple-tools/list/*.ts — Unit 131: simple-tools list tests.
            "tests/extensions/tools/simple-tools/list/*.ts",
            // tests/extensions/tools/web-fetch/*.ts — Unit 132: web-fetch reference tool tests.
            "tests/extensions/tools/web-fetch/*.ts",
            // tests/extensions/state-machines/ralph/*.ts — Unit 133: ralph reference SM tests.
            "tests/extensions/state-machines/ralph/*.ts",
            // tests/flows/*.ts — Units 135-136: end-to-end flow tests.
            "tests/flows/*.ts",
            // tests/flows/_helpers/*.ts — Unit 136: default-chat harness.
            "tests/flows/_helpers/*.ts",
            // examples/<category>/reference/*.ts — reference examples added alongside units.
            "examples/*/*/*.ts",
          ],
          // Raise the limit as new test directories are added alongside units.
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 250,
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
      // NOTE: import-x/extensions is intentionally omitted.
      // TypeScript's NodeNext moduleResolution enforces explicit .js extensions on
      // relative imports at compile time (tsc --noEmit). Adding an ESLint rule here
      // would conflict because TypeScript NodeNext convention is to write `./foo.js`
      // even when the source file is `./foo.ts`, and import-x resolves the real file
      // type and incorrectly flags the .js extension as wrong.
      // The enforcement already exists: a missing extension is a TypeScript compile error.
      //
      // File length cap: every .ts file across src/, tests/, and scripts/ is
      // capped at 500 lines (including blank lines and comments). No carve-outs.
      // See AC-121 and VCP "one module, one job" principle.
      "max-lines": ["error", { max: 500, skipBlankLines: false, skipComments: false }],
      // Function length cap to reinforce single-responsibility.
      "max-lines-per-function": ["error", { max: 100, skipBlankLines: true, skipComments: true }],
    },
  },
  // Scope `throw new Error(string)` ban to src/core/** and src/contracts/** only.
  // Scripts and tests may use plain Error; core and contract code must use
  // typed StudError subclasses (see CLAUDE.md §5 and core/Error-Model.md).
  {
    files: ["src/core/**/*.ts", "src/contracts/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ThrowStatement > NewExpression[callee.name='Error']",
          message: "Use a typed StudError subclass from src/core/errors/. See CLAUDE.md §5.",
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
  // Scripts are trusted internal tools run in CI under controlled conditions.
  // They accept paths from their own logic (not untrusted user input), so the
  // security plugin's non-literal-fs-filename and object-injection warnings are
  // intentional false positives here.
  {
    files: ["scripts/**/*.ts"],
    rules: {
      "security/detect-non-literal-fs-filename": "off",
      "security/detect-object-injection": "off",
    },
  },
  {
    files: ["tests/**/*.ts", "tests/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      // node:test describe/it return void|Promise<void>. The test framework
      // handles the Promise; marking them as floating would cause false positives.
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  {
    files: ["src/core/mcp/client.ts"],
    rules: {
      // TypeScript resolves the SDK's package exports, but import-x cannot resolve
      // these subpath exports under the current resolver stack.
      "import-x/no-unresolved": "off",
    },
  },
  prettierOff,
);
