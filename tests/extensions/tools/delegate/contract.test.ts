/**
 * Contract-shape tests for the bundled delegate tool. Wiki:
 * reference-extensions/tools/Delegate-Tool.md.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  contract,
  deriveDelegateApprovalKey,
} from "../../../../src/extensions/tools/delegate/contract.js";

import type { CanonicalDelegateArgs } from "../../../../src/extensions/tools/delegate/args.js";

const sampleCanonical: CanonicalDelegateArgs = {
  prompt: "do work",
  requestedEnvelope: ["read", "edit"],
  model: { providerId: "anthropic", modelId: "claude-haiku-4-5-20251001" },
  depth: 1,
};

describe("delegate contract", () => {
  it("declares Tool kind with semver and gated=true", () => {
    assert.equal(contract.kind, "Tool");
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/u);
    assert.equal(contract.gated, true);
  });

  it("input schema requires `prompt`", () => {
    const schema = contract.inputSchema as { required: readonly string[] };
    assert.ok(schema.required.includes("prompt"));
  });

  it("model sub-schema requires modelId when present", () => {
    const schema = contract.inputSchema as {
      properties: { model: { required: readonly string[] } };
    };
    assert.deepEqual(schema.properties.model.required, ["modelId"]);
  });

  it("deriveApprovalKey is stable across canonicalArgs orderings", () => {
    const first = deriveDelegateApprovalKey(sampleCanonical);
    const second = deriveDelegateApprovalKey({
      ...sampleCanonical,
      requestedEnvelope: ["edit", "read"],
    });
    assert.equal(first, second);
  });

  it("approval key includes resolved (providerId, modelId, depth, sorted envelope)", () => {
    const key = deriveDelegateApprovalKey(sampleCanonical);
    assert.equal(
      key,
      "delegate:provider=anthropic:model=claude-haiku-4-5-20251001:depth=1:envelope=edit+read",
    );
  });

  it("approval key never embeds the prompt text", () => {
    const key = deriveDelegateApprovalKey(sampleCanonical);
    assert.equal(key.includes(sampleCanonical.prompt), false);
  });

  it("two canonicalArgs differing only in modelId produce different keys", () => {
    const a = deriveDelegateApprovalKey(sampleCanonical);
    const b = deriveDelegateApprovalKey({
      ...sampleCanonical,
      model: { ...sampleCanonical.model, modelId: "claude-opus-4-7" },
    });
    assert.notEqual(a, b);
  });
});
