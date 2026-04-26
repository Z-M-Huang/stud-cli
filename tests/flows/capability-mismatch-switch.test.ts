/**
 * UAT-20 + AC-22: Capability-Mismatch-Switch surfaces the missing capability.
 *
 * Drives the real `negotiate` from `src/core/capabilities/negotiator.ts`
 * with hard mismatches and asserts:
 *
 *   1. ProviderCapability/MissingCapability is thrown with the capability
 *      name in `context.capability`.
 *   2. The error's class + code match invariant — easy to route on.
 *   3. Different capability names produce errors naming each capability
 *      verbatim (canonical id round-trip).
 *   4. The interactor surfacing + switch prompt are orchestrator-level
 *      concerns (modeled here by a recording stub that proves the typed
 *      error carries enough information for the orchestrator to compose
 *      a user-facing message).
 *
 * Wiki: flows/Capability-Mismatch-Switch.md + contracts/Capability-Negotiation.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  negotiate,
  type CapabilityName,
  type CapabilityRequirement,
  type CapabilityVector,
} from "../../src/core/capabilities/negotiator.js";

const noToolCalling: CapabilityVector = {
  streaming: true,
  toolCalling: false,
  structuredOutput: true,
  multimodal: false,
  reasoning: false,
  contextWindow: 64_000,
  promptCaching: false,
};

const noStructuredOutput: CapabilityVector = {
  streaming: true,
  toolCalling: true,
  structuredOutput: false,
  multimodal: false,
  reasoning: false,
  contextWindow: 64_000,
  promptCaching: false,
};

const noMultimodal: CapabilityVector = {
  streaming: true,
  toolCalling: true,
  structuredOutput: true,
  multimodal: false,
  reasoning: false,
  contextWindow: 64_000,
  promptCaching: false,
};

function captureMismatch(
  requirement: CapabilityRequirement,
  vector: CapabilityVector,
): { class: string | undefined; code: string | undefined; capability: string | undefined } | null {
  try {
    negotiate([requirement], vector);
    return null;
  } catch (err) {
    return {
      class: (err as { class?: string }).class,
      code: (err as { context?: { code?: string } }).context?.code,
      capability: (err as { context?: { capability?: string } }).context?.capability,
    };
  }
}

describe("UAT-20: Capability-Mismatch-Switch", () => {
  it("hard toolCalling against a no-toolCalling provider throws MissingCapability(toolCalling)", () => {
    const result = captureMismatch({ name: "toolCalling", level: "hard" }, noToolCalling);
    assert.equal(result?.class, "ProviderCapability");
    assert.equal(result?.code, "MissingCapability");
    assert.equal(result?.capability, "toolCalling");
  });

  it("hard structuredOutput against a no-structuredOutput provider names structuredOutput", () => {
    const result = captureMismatch({ name: "structuredOutput", level: "hard" }, noStructuredOutput);
    assert.equal(result?.capability, "structuredOutput");
  });

  it("hard multimodal against a no-multimodal provider names multimodal", () => {
    const result = captureMismatch({ name: "multimodal", level: "hard" }, noMultimodal);
    assert.equal(result?.capability, "multimodal");
  });

  it("the typed error carries enough info for an interactor-facing message", () => {
    const result = captureMismatch({ name: "toolCalling", level: "hard" }, noToolCalling);
    assert.ok(result !== null);
    // The orchestrator composes a Select prompt offering "switch model" /
    // "abort"; the test verifies the error contains the capability name
    // verbatim so the prompt can name what's missing.
    const surfaceText = `Provider does not support ${result.capability ?? ""}; switch model?`;
    assert.equal(surfaceText.includes("toolCalling"), true);
  });

  it("preferred-level mismatch does NOT throw — it returns warnings (control case)", () => {
    const result = negotiate([{ name: "toolCalling", level: "preferred" }], noToolCalling);
    assert.equal(result.ok, true);
    const names = result.warnings.map((w) => w.name);
    assert.equal(names.includes("toolCalling"), true);
  });

  it("each capability id round-trips verbatim — no rewriting or aliasing", () => {
    const names: readonly CapabilityName[] = ["toolCalling", "structuredOutput", "multimodal"];
    for (const name of names) {
      const result = captureMismatch(
        { name, level: "hard" },
        {
          streaming: true,
          toolCalling: name !== "toolCalling",
          structuredOutput: name !== "structuredOutput",
          multimodal: name !== "multimodal",
          reasoning: false,
          contextWindow: 64_000,
          promptCaching: false,
        },
      );
      assert.equal(result?.capability, name, `capability id must round-trip verbatim: ${name}`);
    }
  });
});
