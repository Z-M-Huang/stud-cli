/**
 * Capability Negotiation contract tests (AC-22).
 *
 * Verifies:
 *   1. CAPABILITY_NAMES enumerates exactly seven capabilities.
 *   2. CAPABILITY_LEVELS enumerates exactly three levels.
 *   3. negotiateCapabilities — hard-ok, hard-miss → MissingCapability, preferred-unmet.
 *   4. capabilityRequirementSchema fixtures — valid / invalid / worst-plausible via AJV.
 *
 * Wiki: contracts/Capability-Negotiation.md, providers/Model-Capabilities.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import {
  CAPABILITY_LEVELS,
  CAPABILITY_NAMES,
  capabilityRequirementSchema,
  negotiateCapabilities,
} from "../../src/contracts/capability-negotiation.js";

import type { ProviderCapabilityClaims } from "../../src/contracts/providers.js";

// ---------------------------------------------------------------------------
// Helper — build a full ProviderCapabilityClaims with per-field overrides
// ---------------------------------------------------------------------------

function fullClaims(overrides: Partial<ProviderCapabilityClaims> = {}): ProviderCapabilityClaims {
  return {
    streaming: "hard",
    toolCalling: "hard",
    structuredOutput: "preferred",
    multimodal: "absent",
    reasoning: "absent",
    contextWindow: 128_000,
    promptCaching: "absent",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. CAPABILITY_NAMES
// ---------------------------------------------------------------------------

describe("CAPABILITY_NAMES", () => {
  it("enumerates exactly seven capabilities", () => {
    assert.equal(CAPABILITY_NAMES.length, 7);
  });

  it("includes 'streaming'", () => {
    assert.ok(CAPABILITY_NAMES.includes("streaming"));
  });

  it("includes 'toolCalling'", () => {
    assert.ok(CAPABILITY_NAMES.includes("toolCalling"));
  });

  it("includes 'structuredOutput'", () => {
    assert.ok(CAPABILITY_NAMES.includes("structuredOutput"));
  });

  it("includes 'multimodal'", () => {
    assert.ok(CAPABILITY_NAMES.includes("multimodal"));
  });

  it("includes 'reasoning'", () => {
    assert.ok(CAPABILITY_NAMES.includes("reasoning"));
  });

  it("includes 'contextWindow'", () => {
    assert.ok(CAPABILITY_NAMES.includes("contextWindow"));
  });

  it("includes 'promptCaching'", () => {
    assert.ok(CAPABILITY_NAMES.includes("promptCaching"));
  });
});

// ---------------------------------------------------------------------------
// 2. CAPABILITY_LEVELS
// ---------------------------------------------------------------------------

describe("CAPABILITY_LEVELS", () => {
  it("enumerates exactly three levels", () => {
    assert.equal(CAPABILITY_LEVELS.length, 3);
  });

  it("includes 'hard'", () => {
    assert.ok(CAPABILITY_LEVELS.includes("hard"));
  });

  it("includes 'preferred'", () => {
    assert.ok(CAPABILITY_LEVELS.includes("preferred"));
  });

  it("includes 'probed'", () => {
    assert.ok(CAPABILITY_LEVELS.includes("probed"));
  });
});

// ---------------------------------------------------------------------------
// 3a. negotiateCapabilities — hard level
// ---------------------------------------------------------------------------

describe("negotiateCapabilities — hard level", () => {
  it("returns ok:true with no warnings when a hard requirement is met", () => {
    const result = negotiateCapabilities(
      [{ name: "streaming", level: "hard" }],
      fullClaims({ streaming: "hard" }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return assert.fail("expected ok:true");
    assert.equal(result.warnings.length, 0);
  });

  it("returns ok:true with no warnings when multiple hard requirements are all met", () => {
    const result = negotiateCapabilities(
      [
        { name: "streaming", level: "hard" },
        { name: "toolCalling", level: "hard" },
      ],
      fullClaims({ streaming: "hard", toolCalling: "hard" }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return assert.fail("expected ok:true");
    assert.equal(result.warnings.length, 0);
  });

  it("returns ok:false with MissingCapability on a hard miss", () => {
    const result = negotiateCapabilities(
      [{ name: "multimodal", level: "hard" }],
      fullClaims({ multimodal: "absent" }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return assert.fail("expected ok:false");
    assert.equal(result.error.class, "ProviderCapability");
    assert.equal(result.error.context["code"], "MissingCapability");
    assert.equal(result.error.context["name"], "multimodal");
  });

  it("names the offending capability in MissingCapability context", () => {
    const result = negotiateCapabilities(
      [{ name: "reasoning", level: "hard" }],
      fullClaims({ reasoning: "absent" }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return assert.fail("expected ok:false");
    assert.equal(result.error.context["name"], "reasoning");
  });

  it("stops at the first hard miss without accumulating multiple failures", () => {
    const result = negotiateCapabilities(
      [
        { name: "multimodal", level: "hard" },
        { name: "reasoning", level: "hard" },
      ],
      fullClaims({ multimodal: "absent", reasoning: "absent" }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return assert.fail("expected ok:false");
    const failedName = result.error.context["name"] as string;
    assert.ok(
      failedName === "multimodal" || failedName === "reasoning",
      `expected first hard miss to be named; got '${failedName}'`,
    );
  });

  it("returns ok:true with empty requirements", () => {
    const result = negotiateCapabilities([], fullClaims());
    assert.equal(result.ok, true);
    if (!result.ok) return assert.fail("expected ok:true");
    assert.equal(result.warnings.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 3b. negotiateCapabilities — preferred level
// ---------------------------------------------------------------------------

describe("negotiateCapabilities — preferred level", () => {
  it("adds preferred-unmet warning when preferred capability is absent", () => {
    const result = negotiateCapabilities(
      [{ name: "promptCaching", level: "preferred" }],
      fullClaims({ promptCaching: "absent" }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return assert.fail("expected ok:true");
    const unmet = result.warnings.filter((w) => w.reason === "preferred-unmet");
    assert.ok(unmet.length > 0, "expected at least one preferred-unmet warning");
    assert.equal(unmet[0]?.name, "promptCaching");
  });

  it("produces no warnings when preferred capability is present", () => {
    const result = negotiateCapabilities(
      [{ name: "structuredOutput", level: "preferred" }],
      fullClaims({ structuredOutput: "hard" }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return assert.fail("expected ok:true");
    assert.equal(result.warnings.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 3c. negotiateCapabilities — probed level
// ---------------------------------------------------------------------------

describe("negotiateCapabilities — probed level", () => {
  it("adds probe-pending warning for probed requirements regardless of claim", () => {
    const result = negotiateCapabilities([{ name: "reasoning", level: "probed" }], fullClaims());
    assert.equal(result.ok, true);
    if (!result.ok) return assert.fail("expected ok:true");
    const pending = result.warnings.filter((w) => w.reason === "probe-pending");
    assert.ok(pending.length > 0, "expected at least one probe-pending warning");
    assert.equal(pending[0]?.name, "reasoning");
  });
});

// ---------------------------------------------------------------------------
// 3d. negotiateCapabilities — contextWindow special handling
// ---------------------------------------------------------------------------

describe("negotiateCapabilities — contextWindow", () => {
  it("fails hard requirement when claim is below minimum", () => {
    const result = negotiateCapabilities(
      [{ name: "contextWindow", level: "hard", minimum: 200_000 }],
      fullClaims({ contextWindow: 32_000 }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return assert.fail("expected ok:false");
    assert.equal(result.error.context["code"], "MissingCapability");
    assert.equal(result.error.context["name"], "contextWindow");
  });

  it("passes hard requirement when claim meets minimum", () => {
    const result = negotiateCapabilities(
      [{ name: "contextWindow", level: "hard", minimum: 32_000 }],
      fullClaims({ contextWindow: 128_000 }),
    );
    assert.equal(result.ok, true);
  });

  it("defers to probe-pending when claim is 'probed'", () => {
    const result = negotiateCapabilities(
      [{ name: "contextWindow", level: "hard", minimum: 32_000 }],
      fullClaims({ contextWindow: "probed" }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return assert.fail("expected ok:true");
    const pending = result.warnings.filter((w) => w.reason === "probe-pending");
    assert.ok(pending.length > 0, "expected probe-pending for probed contextWindow");
  });
});

// ---------------------------------------------------------------------------
// 4. capabilityRequirementSchema fixtures
// ---------------------------------------------------------------------------

describe("capabilityRequirementSchema", () => {
  // AJV v6: strip $schema before compiling.
  const { $schema: _ignored, ...compilableSchema } = capabilityRequirementSchema as Record<
    string,
    unknown
  >;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableSchema);

  it("accepts a valid requirement", () => {
    const result = validate({ name: "streaming", level: "hard" });
    assert.equal(
      result,
      true,
      `Expected valid fixture to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("accepts a valid contextWindow requirement with a minimum", () => {
    const result = validate({ name: "contextWindow", level: "hard", minimum: 32_000 });
    assert.equal(
      result,
      true,
      `Expected contextWindow+minimum fixture to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("rejects an unknown capability name and reports path at /name", () => {
    const result = validate({ name: "bogus", level: "hard" });
    assert.equal(result, false, "Expected unknown name to be rejected");
    const errors = validate.errors ?? [];
    const nameError = errors.find(
      (e) =>
        String((e as { dataPath?: string }).dataPath ?? "").includes("name") ||
        String(e.schemaPath ?? "").includes("enum"),
    );
    assert.ok(
      nameError != null,
      `Expected an error referencing 'name'; got ${JSON.stringify(errors)}`,
    );
  });

  it("rejects an unknown level", () => {
    const result = validate({ name: "streaming", level: "optional" });
    assert.equal(result, false, "Expected unknown level to be rejected");
  });

  it("rejects missing required 'name' field", () => {
    const result = validate({ level: "hard" });
    assert.equal(result, false, "Expected missing name to be rejected");
  });

  it("rejects missing required 'level' field", () => {
    const result = validate({ name: "streaming" });
    assert.equal(result, false, "Expected missing level to be rejected");
  });

  it("rejects worst-plausible input without AJV throwing", () => {
    let rejected: boolean;
    try {
      rejected = !validate({
        name: "streaming",
        level: "hard",
        extra: "x".repeat(1_000_000),
      });
    } catch (err) {
      return assert.fail(`AJV threw on worst-plausible input: ${String(err)}`);
    }
    assert.ok(rejected, "Expected worst-plausible fixture to be rejected");
  });
});
