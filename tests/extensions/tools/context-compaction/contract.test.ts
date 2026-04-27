/**
 * Contract conformance tests for the context-compaction reference tool.
 *
 * Covers: shape, approval-key stability, compaction summary return, post-
 * compaction persist, audit emission, arg-validation errors,
 * store-unavailable error path, and idempotent dispose.
 *
 * Uses node:test + node:assert/strict (project canonical test runner).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { Session } from "../../../../src/core/errors/index.js";
import { setCompactFn } from "../../../../src/extensions/tools/context-compaction/execute.js";
import { contract } from "../../../../src/extensions/tools/context-compaction/index.js";
import { mockHost } from "../../../helpers/mock-host.js";

import type { StateSlotHandle } from "../../../../src/core/host/api/session.js";
import type { HostAPI } from "../../../../src/core/host/host-api.js";
import type { CompactionSummary } from "../../../../src/extensions/tools/context-compaction/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SUMMARY: CompactionSummary = {
  compactedSegments: 3,
  originalTokens: 10_000,
  compactedTokens: 4_000,
  newUtilizationPercent: 40,
  summary: "condensed 7 turns into a brief overview",
};

const SMALL_SUMMARY: CompactionSummary = {
  compactedSegments: 1,
  originalTokens: 1_000,
  compactedTokens: 500,
  newUtilizationPercent: 50,
  summary: "condensed",
};

const signal = new AbortController().signal;

/**
 * Spread the frozen mockHost into a new frozen host, replacing the session
 * with a version whose `stateSlot.write` always rejects.
 */
function makeFailingStoreHost(): HostAPI {
  const { host } = mockHost({ extId: "context-compaction" });
  const failingSlot: StateSlotHandle = {
    read: () => Promise.resolve(null),
    write: () =>
      Promise.reject(
        new Session("session store unavailable", undefined, {
          code: "StoreUnavailable",
        }),
      ),
  };
  const failingSession = {
    id: host.session.id,
    mode: host.session.mode,
    projectRoot: host.session.projectRoot,
    stateSlot: (_extId: string): StateSlotHandle => failingSlot,
  };
  return Object.freeze({ ...host, session: failingSession });
}

// Reset the compact function after each test to avoid cross-test interference.
afterEach(() => {
  setCompactFn(undefined);
});

// ---------------------------------------------------------------------------
// Shape / contract declaration
// ---------------------------------------------------------------------------

describe("context-compaction tool — shape", () => {
  it("declares Tool category", () => {
    assert.equal(contract.kind, "Tool");
  });

  it("registers under manifestKey 'context-compaction'", () => {
    assert.equal(contract.discoveryRules.manifestKey, "context-compaction");
  });

  it("is gated by the approval stack", () => {
    assert.equal(contract.gated, true);
  });

  it("declares a semver contractVersion", () => {
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
  });

  it("declares a non-empty requiredCoreVersion range", () => {
    assert.ok(contract.requiredCoreVersion.length > 0);
  });

  it("declares a stateSlot shape for compaction metrics persistence", () => {
    assert.ok(
      contract.stateSlot !== null,
      "stateSlot must not be null — execute.ts writes to it ( crash-durability)",
    );
    assert.match(contract.stateSlot.slotVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(typeof contract.stateSlot.schema, "object");
  });

  it("loadedCardinality is unlimited", () => {
    assert.equal(contract.loadedCardinality, "unlimited");
  });

  it("activeCardinality is unlimited", () => {
    assert.equal(contract.activeCardinality, "unlimited");
  });

  it("exposes inputSchema and outputSchema as objects", () => {
    assert.equal(typeof contract.inputSchema, "object");
    assert.equal(typeof contract.outputSchema, "object");
  });
});

// ---------------------------------------------------------------------------
// Approval key stability (, Q-8 resolution)
// ---------------------------------------------------------------------------

describe("context-compaction tool — deriveApprovalKey", () => {
  it("returns fixed 'context-compaction' for empty args", () => {
    assert.equal(contract.deriveApprovalKey({}), "context-compaction");
  });

  it("returns the same key regardless of optional args", () => {
    const keyA = contract.deriveApprovalKey({});
    const keyB = contract.deriveApprovalKey({
      targetUtilizationPercent: 70,
      preserveRecentTurns: 5,
    });
    assert.equal(keyA, keyB);
    assert.equal(keyA, "context-compaction");
  });
});

// ---------------------------------------------------------------------------
// Execute — happy path
// ---------------------------------------------------------------------------

describe("context-compaction tool — execute success", () => {
  it("returns a CompactionSummary with correct shape", async () => {
    setCompactFn(() => Promise.resolve(MOCK_SUMMARY));
    const { host } = mockHost({ extId: "context-compaction" });
    await contract.lifecycle.init!(host, {});

    const result = await contract.execute({}, host, signal);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(typeof result.value.compactedSegments, "number");
      assert.equal(typeof result.value.originalTokens, "number");
      assert.equal(typeof result.value.compactedTokens, "number");
      assert.equal(typeof result.value.newUtilizationPercent, "number");
      assert.equal(typeof result.value.summary, "string");
    }
  });

  it("returns the summary values from the compaction subsystem", async () => {
    setCompactFn(() => Promise.resolve(MOCK_SUMMARY));
    const { host } = mockHost({ extId: "context-compaction" });
    await contract.lifecycle.init!(host, {});

    const result = await contract.execute({}, host, signal);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.compactedSegments, 3);
      assert.equal(result.value.newUtilizationPercent, 40);
      assert.equal(result.value.originalTokens, 10_000);
      assert.equal(result.value.compactedTokens, 4_000);
      assert.equal(result.value.summary, "condensed 7 turns into a brief overview");
    }
  });

  it("resolves args using config defaults when args are omitted", async () => {
    const capturedArgs: { targetUtilizationPercent?: number; preserveRecentTurns?: number }[] = [];
    setCompactFn((args) => {
      capturedArgs.push({ ...args });
      return Promise.resolve(SMALL_SUMMARY);
    });
    const { host } = mockHost({ extId: "context-compaction" });
    await contract.lifecycle.init!(host, {
      defaultTargetUtilizationPercent: 70,
      defaultPreserveRecentTurns: 4,
    });

    await contract.execute({}, host, signal);

    assert.equal(capturedArgs.length, 1);
    assert.equal(capturedArgs[0]?.targetUtilizationPercent, 70);
    assert.equal(capturedArgs[0]?.preserveRecentTurns, 4);
  });

  it("uses core fallbacks (80 / 2) when neither args nor config supply values", async () => {
    const capturedArgs: { targetUtilizationPercent?: number; preserveRecentTurns?: number }[] = [];
    setCompactFn((args) => {
      capturedArgs.push({ ...args });
      return Promise.resolve(SMALL_SUMMARY);
    });
    const { host } = mockHost({ extId: "context-compaction" });
    await contract.lifecycle.init!(host, {});

    await contract.execute({}, host, signal);

    assert.equal(capturedArgs[0]?.targetUtilizationPercent, 80);
    assert.equal(capturedArgs[0]?.preserveRecentTurns, 2);
  });
});

// ---------------------------------------------------------------------------
// Execute — persist
// ---------------------------------------------------------------------------

describe("context-compaction tool — persist", () => {
  it("writes to the active Session Store before returning", async () => {
    setCompactFn(() => Promise.resolve(SMALL_SUMMARY));
    const { host } = mockHost({ extId: "context-compaction" });
    await contract.lifecycle.init!(host, {});

    const result = await contract.execute({}, host, signal);

    assert.equal(result.ok, true);
    const persisted = await host.session.stateSlot("context-compaction").read();
    assert.ok(persisted !== null, "state slot should be non-null after execute");
  });

  it("persisted state includes the compaction metrics", async () => {
    setCompactFn(() => Promise.resolve(SMALL_SUMMARY));
    const { host } = mockHost({ extId: "context-compaction" });
    await contract.lifecycle.init!(host, {});
    await contract.execute({}, host, signal);

    const persisted = await host.session.stateSlot("context-compaction").read();
    assert.ok(persisted !== null);
    assert.equal(persisted["compactedSegments"], 1);
    assert.equal(persisted["newUtilizationPercent"], 50);
  });
});

// ---------------------------------------------------------------------------
// Execute — audit
// ---------------------------------------------------------------------------

describe("context-compaction tool — audit", () => {
  it("emits a Compaction audit record", async () => {
    setCompactFn(() => Promise.resolve(SMALL_SUMMARY));
    const { host, recorders } = mockHost({ extId: "context-compaction" });
    await contract.lifecycle.init!(host, {});

    await contract.execute({}, host, signal);

    assert.ok(
      recorders.audit.records.some((r) => r.class === "Compaction"),
      "expected a Compaction audit record",
    );
  });

  it("audit record carries before/after token counts", async () => {
    setCompactFn(() => Promise.resolve(SMALL_SUMMARY));
    const { host, recorders } = mockHost({ extId: "context-compaction" });
    await contract.lifecycle.init!(host, {});
    await contract.execute({}, host, signal);

    const rec = recorders.audit.records.find((r) => r.class === "Compaction");
    assert.ok(rec !== undefined, "Compaction record not found");
    assert.equal(rec.payload["compactedSegments"], 1);
    assert.equal(rec.payload["originalTokens"], 1_000);
    assert.equal(rec.payload["compactedTokens"], 500);
  });

  it("audit record does not contain raw message content", async () => {
    setCompactFn(() =>
      Promise.resolve({
        ...SMALL_SUMMARY,
        summary: "contains user secret: password123",
      }),
    );
    const { host, recorders } = mockHost({ extId: "context-compaction" });
    await contract.lifecycle.init!(host, {});
    await contract.execute({}, host, signal);

    const rec = recorders.audit.records.find((r) => r.class === "Compaction");
    assert.ok(rec !== undefined);
    // summary field must not appear in the audit payload (invariant #6)
    assert.ok(
      !JSON.stringify(rec.payload).includes("password123"),
      "audit record must not contain message content",
    );
  });
});

// ---------------------------------------------------------------------------
// Execute — validation errors
// ---------------------------------------------------------------------------

describe("context-compaction tool — validation errors", () => {
  it("targetUtilizationPercent > 100 → throws Validation/ConfigSchemaViolation", async () => {
    const { host } = mockHost({ extId: "context-compaction" });
    await contract.lifecycle.init!(host, {});

    await assert.rejects(
      async () => contract.execute({ targetUtilizationPercent: 150 }, host, signal),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "Validation");
        assert.equal(
          (err as { context?: { code?: unknown } }).context?.code,
          "ConfigSchemaViolation",
        );
        return true;
      },
    );
  });

  it("targetUtilizationPercent < 0 → throws Validation/ConfigSchemaViolation", async () => {
    const { host } = mockHost({ extId: "context-compaction" });
    await contract.lifecycle.init!(host, {});

    await assert.rejects(
      async () => contract.execute({ targetUtilizationPercent: -1 }, host, signal),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "Validation");
        return true;
      },
    );
  });

  it("preserveRecentTurns < 0 → throws Validation/ConfigSchemaViolation", async () => {
    const { host } = mockHost({ extId: "context-compaction" });
    await contract.lifecycle.init!(host, {});

    await assert.rejects(
      async () => contract.execute({ preserveRecentTurns: -5 }, host, signal),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "Validation");
        assert.equal(
          (err as { context?: { code?: unknown } }).context?.code,
          "ConfigSchemaViolation",
        );
        return true;
      },
    );
  });

  it("targetUtilizationPercent exactly 0 is valid", async () => {
    setCompactFn(() => Promise.resolve(SMALL_SUMMARY));
    const { host } = mockHost({ extId: "context-compaction" });
    await contract.lifecycle.init!(host, {});

    const result = await contract.execute({ targetUtilizationPercent: 0 }, host, signal);
    assert.equal(result.ok, true);
  });

  it("targetUtilizationPercent exactly 100 is valid", async () => {
    setCompactFn(() => Promise.resolve(SMALL_SUMMARY));
    const { host } = mockHost({ extId: "context-compaction" });
    await contract.lifecycle.init!(host, {});

    const result = await contract.execute({ targetUtilizationPercent: 100 }, host, signal);
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// Execute — store failure
// ---------------------------------------------------------------------------

describe("context-compaction tool — store failure", () => {
  it("store persist fails → throws Session/StoreUnavailable", async () => {
    setCompactFn(() => Promise.resolve(SMALL_SUMMARY));
    const failingHost = makeFailingStoreHost();
    await contract.lifecycle.init!(failingHost, {});

    await assert.rejects(
      async () => contract.execute({}, failingHost, signal),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "Session");
        assert.equal((err as { context?: { code?: unknown } }).context?.code, "StoreUnavailable");
        return true;
      },
    );
  });

  it("compaction subsystem throws → returns ToolTerminal/OutputMalformed", async () => {
    setCompactFn(() => Promise.reject(new Error("unexpected subsystem failure")));
    const { host } = mockHost({ extId: "context-compaction" });
    await contract.lifecycle.init!(host, {});

    const result = await contract.execute({}, host, signal);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "OutputMalformed");
    }
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("context-compaction tool — lifecycle", () => {
  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "context-compaction" });
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });

  it("runs init then dispose without error", async () => {
    const { host } = mockHost({ extId: "context-compaction" });
    const order: string[] = [];

    await contract.lifecycle.init!(host, {});
    order.push("init");
    await contract.lifecycle.dispose!(host);
    order.push("dispose");

    assert.deepEqual(order, ["init", "dispose"]);
  });

  it("dispose after dispose does not throw", async () => {
    const { host } = mockHost({ extId: "context-compaction" });
    await contract.lifecycle.init!(host, {});
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });
});
