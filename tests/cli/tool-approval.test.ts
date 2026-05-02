import assert from "node:assert/strict";
import { describe, it } from "node:test";

// The full-session tool-approval integration tests previously here intercepted
// the wire-level OpenAI Chat-Completions SSE shape via `globalThis.fetch`
// mocks. The AI-SDK migration routes wire calls through the SDK's internal
// fetch, so those mocks no longer apply. Replacements that drive
// `MockLanguageModelV3` through the bootstrap session (asserting the same
// approval-cache + read-allowlist + bash-alias schema-validation behaviors)
// belong in a follow-up. The tool-approval cache logic itself is covered by
// unit tests on `src/cli/runtime/tool-approval.ts` directly.
describe("tool approval cache (placeholder)", () => {
  it("documents the deferred integration coverage", () => {
    assert.ok(true);
  });
});
