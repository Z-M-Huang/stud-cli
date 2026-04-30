import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertFragmentNotForbidden } from "../../../src/core/context/forbidden-source-guard.js";
import { Validation } from "../../../src/core/errors/validation.js";


import type { ContextFragment } from "../../../src/core/context/assembler.js";

function fragment(content: string, ownerExtId = "test-ext"): ContextFragment {
  return {
    kind: "system-message",
    content,
    priority: 1,
    budget: 1024,
    ownerExtId,
  };
}

// Fixtures are constructed at runtime from base64 so the source file
// contains no token-shaped substring matching the redactor's regexes.
function decode(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf8");
}
const FAKE_ANTHROPIC = decode("c2stYW50LUZBS0VfVE9LRU5fVEVTVDEyMw==");
const FAKE_OPENAI = decode("c2stdGVzdC1FWEFNUExFLTAwMDAwMDAwMDAwMDAw");
const FAKE_GITHUB = decode("Z2hwX2V4YW1wbGVUb2tlbjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw");
const FAKE_GOOGLE = decode("QUl6YVN5RXhhbXBsZS0wMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA");

describe("assertFragmentNotForbidden", () => {
  it("accepts plain content with no credential-shaped tokens", () => {
    assert.doesNotThrow(() => {
      assertFragmentNotForbidden(fragment("Hello, please summarize the changes."));
    });
  });

  it("rejects an Anthropic-prefixed token with Validation/ContextContainsForbiddenSource", () => {
    let caught: unknown;
    try {
      assertFragmentNotForbidden(fragment(`Pasted log: ${FAKE_ANTHROPIC} (oops)`));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Validation);
    assert.equal(caught.context["code"], "ContextContainsForbiddenSource");
    assert.equal(caught.context["ownerExtId"], "test-ext");
  });

  it("rejects a generic OpenAI-shaped token", () => {
    assert.throws(
      () => assertFragmentNotForbidden(fragment(`API key: ${FAKE_OPENAI}`)),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "ContextContainsForbiddenSource");
        return true;
      },
    );
  });

  it("rejects a GitHub PAT", () => {
    assert.throws(
      () => assertFragmentNotForbidden(fragment(`token=${FAKE_GITHUB}`)),
      (error: unknown) => error instanceof Validation,
    );
  });

  it("rejects a Google API key", () => {
    assert.throws(
      () => assertFragmentNotForbidden(fragment(`key: ${FAKE_GOOGLE}`)),
      (error: unknown) => error instanceof Validation,
    );
  });

  it("includes the offending Context Provider extId in the error context", () => {
    let caught: Validation | undefined;
    try {
      assertFragmentNotForbidden(fragment(`leak: ${FAKE_ANTHROPIC}`, "system-prompt-file"));
    } catch (error) {
      if (error instanceof Validation) caught = error;
    }
    assert.ok(caught);
    assert.equal(caught.context["ownerExtId"], "system-prompt-file");
    assert.equal(caught.context["fragmentKind"], "system-message");
  });
});
