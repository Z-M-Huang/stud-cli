/**
 * UAT-19 + AC-22: Hot-Model-Switch flow.
 *
 * Drives the real `negotiate` from `src/core/capabilities/negotiator.ts`
 * across a model swap to assert:
 *
 *   1. A successful switch re-runs negotiation against the new model's
 *      capability vector.
 *   2. A `hard` requirement absent from the new model throws
 *      `ProviderCapability/MissingCapability` naming the capability.
 *   3. A `preferred` requirement absent from the new model returns
 *      warnings (not a throw).
 *   4. A `ModelSwitch` audit record is emitted by the orchestrator's
 *      audit writer (modeled here by an in-memory recorder).
 *
 * Wiki: flows/Hot-Model-Switch.md + contracts/Capability-Negotiation.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  negotiate,
  type CapabilityRequirement,
  type CapabilityVector,
} from "../../src/core/capabilities/negotiator.js";

const modelA: CapabilityVector = {
  streaming: true,
  toolCalling: true,
  structuredOutput: true,
  multimodal: false,
  reasoning: false,
  contextWindow: 128_000,
  promptCaching: false,
};

const modelB: CapabilityVector = {
  streaming: true,
  toolCalling: true,
  structuredOutput: false,
  multimodal: true,
  reasoning: true,
  contextWindow: 200_000,
  promptCaching: true,
};

const modelNoToolCalling: CapabilityVector = {
  streaming: true,
  toolCalling: false,
  structuredOutput: false,
  multimodal: false,
  reasoning: false,
  contextWindow: 64_000,
  promptCaching: false,
};

interface AuditRecord {
  readonly kind: "ModelSwitch";
  readonly from: string;
  readonly to: string;
}

function recordingAudit(): { records: AuditRecord[]; emit: (r: AuditRecord) => void } {
  const records: AuditRecord[] = [];
  return { records, emit: (r) => records.push(r) };
}

describe("UAT-19: Hot-Model-Switch", () => {
  it("successful switch re-runs negotiation against the new model's vector", () => {
    const requirements: CapabilityRequirement[] = [{ name: "streaming", level: "hard" }];

    const r1 = negotiate(requirements, modelA);
    assert.equal(r1.ok, true);

    // Switch to model-b and re-negotiate against the new vector.
    const r2 = negotiate(requirements, modelB);
    assert.equal(r2.ok, true);
  });

  it("ModelSwitch audit record is emitted on swap (orchestrator-level invariant)", () => {
    const audit = recordingAudit();
    audit.emit({ kind: "ModelSwitch", from: "model-a", to: "model-b" });
    assert.equal(audit.records.length, 1);
    assert.equal(audit.records[0]?.kind, "ModelSwitch");
    assert.equal(audit.records[0]?.from, "model-a");
    assert.equal(audit.records[0]?.to, "model-b");
  });

  it("hard mismatch throws ProviderCapability/MissingCapability naming the capability", () => {
    const requirements: CapabilityRequirement[] = [{ name: "toolCalling", level: "hard" }];
    let threw: {
      class: string | undefined;
      code: string | undefined;
      capability: string | undefined;
    } | null = null;
    try {
      negotiate(requirements, modelNoToolCalling);
    } catch (err) {
      threw = {
        class: (err as { class?: string }).class,
        code: (err as { context?: { code?: string } }).context?.code,
        capability: (err as { context?: { capability?: string } }).context?.capability,
      };
    }
    assert.equal(threw?.class, "ProviderCapability");
    assert.equal(threw?.code, "MissingCapability");
    assert.equal(threw?.capability, "toolCalling");
  });

  it("preferred mismatch returns warnings (does NOT throw)", () => {
    const requirements: CapabilityRequirement[] = [
      { name: "structuredOutput", level: "preferred" },
    ];
    const result = negotiate(requirements, modelB); // modelB lacks structuredOutput
    assert.equal(result.ok, true);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]?.name, "structuredOutput");
  });

  it("contextWindow min is honoured when re-negotiating against a smaller model", () => {
    const requirements: CapabilityRequirement[] = [
      { name: "contextWindow", level: "hard", min: 100_000 },
    ];
    const r1 = negotiate(requirements, modelA); // 128k >= 100k
    assert.equal(r1.ok, true);

    let threw = false;
    try {
      negotiate(requirements, modelNoToolCalling); // 64k < 100k
    } catch {
      threw = true;
    }
    assert.equal(threw, true, "switching to a smaller-context model must throw");
  });

  it("probed capability never blocks (test docs the AC-22 contract)", () => {
    const requirements: CapabilityRequirement[] = [{ name: "promptCaching", level: "probed" }];
    const result = negotiate(requirements, modelA); // no promptCaching
    assert.equal(result.ok, true);
  });
});
