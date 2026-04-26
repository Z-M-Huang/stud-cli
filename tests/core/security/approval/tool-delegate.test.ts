/**
 * Tests for the tool contract registry delegate.
 *
 * Covers:
 *   - Happy path: register and lookup a tool contract.
 *   - Error path: lookup an unregistered toolId → ToolTerminal/ToolNotRegistered.
 *   - Idempotence: a second registration overwrites the first.
 *
 * Wiki: contracts/Tools.md, security/Tool-Approvals.md
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ToolTerminal } from "../../../../src/core/errors/tool-terminal.js";
import { createToolContractRegistry } from "../../../../src/core/security/approval/tool-delegate.js";

import type { ToolContract } from "../../../../src/contracts/tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal `ToolContract` stub suitable for registry tests.
 * All fields satisfy the contract shape; no real side effects.
 */
function makeContract(id: string): ToolContract {
  return {
    kind: "Tool",
    contractVersion: "1.0.0",
    requiredCoreVersion: ">=1.0.0 <2.0.0",
    lifecycle: {},
    configSchema: { type: "object", additionalProperties: false } as const,
    loadedCardinality: "unlimited",
    activeCardinality: "unlimited",
    stateSlot: null,
    discoveryRules: { folder: "tools", manifestKey: id },
    reloadBehavior: "between-turns",
    inputSchema: { type: "object" } as const,
    outputSchema: { type: "object" } as const,
    execute: (_args, _host, _signal) => Promise.resolve({ ok: true as const, value: {} }),
    gated: false,
    deriveApprovalKey: (_args) => `${id}:*`,
  };
}

// ---------------------------------------------------------------------------
// createToolContractRegistry — happy path
// ---------------------------------------------------------------------------

describe("ToolContractRegistry — happy path", () => {
  it("returns the exact contract object registered under a toolId", () => {
    const registry = createToolContractRegistry();
    const contract = makeContract("read");

    registry.register("read", contract);
    const found = registry.lookup("read");

    assert.strictEqual(found, contract, "lookup must return the identical contract object");
  });

  it("lookup returns the contract for each of several registered tools", () => {
    const registry = createToolContractRegistry();
    const readContract = makeContract("read");
    const bashContract = makeContract("bash");

    registry.register("read", readContract);
    registry.register("bash", bashContract);

    assert.strictEqual(registry.lookup("read"), readContract);
    assert.strictEqual(registry.lookup("bash"), bashContract);
  });
});

// ---------------------------------------------------------------------------
// createToolContractRegistry — error path
// ---------------------------------------------------------------------------

describe("ToolContractRegistry — error path", () => {
  it("throws ToolTerminal/ToolNotRegistered for an unknown toolId", () => {
    const registry = createToolContractRegistry();

    assert.throws(
      () => registry.lookup("unknown-tool"),
      (err: unknown) => {
        assert.ok(err instanceof ToolTerminal, "error must be ToolTerminal");
        assert.equal(err.context["code"], "ToolNotRegistered");
        assert.equal(err.context["toolId"], "unknown-tool");
        return true;
      },
    );
  });

  it("throws ToolTerminal/ToolNotRegistered even after other tools are registered", () => {
    const registry = createToolContractRegistry();
    registry.register("read", makeContract("read"));

    assert.throws(
      () => registry.lookup("bash"),
      (err: unknown) => {
        assert.ok(err instanceof ToolTerminal);
        assert.equal(err.context["code"], "ToolNotRegistered");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// createToolContractRegistry — idempotence / overwrite
// ---------------------------------------------------------------------------

describe("ToolContractRegistry — second registration overwrites the first", () => {
  it("lookup returns the second contract when the same toolId is registered twice", () => {
    const registry = createToolContractRegistry();
    const first = makeContract("read");
    const second = makeContract("read");

    registry.register("read", first);
    registry.register("read", second);

    const found = registry.lookup("read");
    assert.strictEqual(found, second, "second registration must overwrite the first");
    assert.notStrictEqual(found, first, "first contract must no longer be returned");
  });
});
