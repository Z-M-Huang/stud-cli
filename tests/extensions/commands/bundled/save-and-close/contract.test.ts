/**
 * Contract conformance tests for the /save-and-close bundled command.
 *
 * Covers: shape, drain-success, drain-timeout, store-failure, approval-free
 * semantics, idempotent dispose, and lifecycle ordering.
 *
 * Uses node:test + node:assert/strict (project canonical test runner).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Session } from "../../../../../src/core/errors/index.js";
import {
  contract,
  injectDrainContext,
} from "../../../../../src/extensions/commands/bundled/save-and-close/index.js";
import { mockHost } from "../../../../helpers/mock-host.js";

import type { CommandArgs } from "../../../../../src/contracts/commands.js";
import type {
  DrainContext,
  DrainResult,
  SaveAndCloseResult,
} from "../../../../../src/extensions/commands/bundled/save-and-close/drain.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Minimal valid CommandArgs for a bare /save-and-close invocation. */
const EMPTY_ARGS: CommandArgs = { raw: "", positional: [], flags: {} };

/** A drain context that resolves immediately with the given result. */
function successDrain(result: DrainResult): DrainContext {
  return {
    drain(_deadlineMs: number): Promise<DrainResult> {
      return Promise.resolve(result);
    },
  };
}

/** A drain context that never resolves (stalls indefinitely). */
function stalledDrain(): { ctx: DrainContext; resolve: () => void } {
  let resolveHolder: ((r: DrainResult) => void) | undefined;
  const ctx: DrainContext = {
    drain(_deadlineMs: number): Promise<DrainResult> {
      return new Promise<DrainResult>((res) => {
        resolveHolder = res;
      });
    },
  };
  return {
    ctx,
    resolve(): void {
      resolveHolder?.({ drainedTurns: 0, sessionPath: "" });
    },
  };
}

/** A drain context that throws Session/StoreUnavailable. */
function unavailableDrain(): DrainContext {
  return {
    drain(_deadlineMs: number): Promise<DrainResult> {
      return Promise.reject(
        new Session("store refused final write", undefined, {
          code: "StoreUnavailable",
          storeId: "test-store",
        }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Shape / contract declaration tests
// ---------------------------------------------------------------------------

describe("/save-and-close command — shape", () => {
  it("declares Command category", () => {
    assert.equal(contract.kind, "Command");
  });

  it("declares name /save-and-close", () => {
    assert.equal(contract.name, "/save-and-close");
  });

  it("declares a semver contractVersion", () => {
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
  });

  it("declares a non-empty requiredCoreVersion range", () => {
    assert.ok(contract.requiredCoreVersion.length > 0);
  });

  it("has no state slot (stateless command)", () => {
    assert.equal(contract.stateSlot, null);
  });

  it("has loadedCardinality unlimited", () => {
    assert.equal(contract.loadedCardinality, "unlimited");
  });

  it("has activeCardinality unlimited", () => {
    assert.equal(contract.activeCardinality, "unlimited");
  });

  it("has a non-empty description", () => {
    assert.ok(typeof contract.description === "string" && contract.description.length > 0);
  });

  it("has a parseable configSchema", () => {
    assert.equal(typeof contract.configSchema, "object");
    assert.equal((contract.configSchema as { type?: string }).type, "object");
  });

  it("is not approval-gated (no requiresApproval field on CommandContract)", () => {
    // CommandContract does not define requiresApproval; invoking /save-and-close
    // requires no extra user confirmation (AC-110).
    const c = contract as unknown as { requiresApproval?: unknown };
    assert.equal(c.requiresApproval, undefined);
  });
});

// ---------------------------------------------------------------------------
// Drain success tests
// ---------------------------------------------------------------------------

describe("/save-and-close command — drain success", () => {
  it("drains in-flight turns, persists, and signals SessionExitRequested", async () => {
    const { host, recorders } = mockHost({ extId: "save-and-close" });
    await contract.lifecycle.init!(host, {});
    injectDrainContext(host, successDrain({ drainedTurns: 2, sessionPath: "/tmp/.stud/s1.json" }));

    const result = await contract.execute(EMPTY_ARGS, host);

    assert.ok(result.payload !== undefined, "payload must be set");
    const payload = result.payload as unknown as SaveAndCloseResult;
    assert.equal(payload.persisted, true);
    assert.equal(payload.drainedTurns, 2);
    assert.equal(payload.sessionPath, "/tmp/.stud/s1.json");

    const exitEvent = recorders.events.records.find((r) => r.type === "SessionExitRequested");
    assert.ok(exitEvent !== undefined, "SessionExitRequested event must be emitted");
    assert.equal((exitEvent.payload as { forced?: boolean }).forced, false);
  });

  it("writes a SessionLifecycle audit record on success", async () => {
    const { host, recorders } = mockHost({ extId: "save-and-close" });
    await contract.lifecycle.init!(host, {});
    injectDrainContext(host, successDrain({ drainedTurns: 1, sessionPath: "/path" }));

    await contract.execute(EMPTY_ARGS, host);

    const auditRec = recorders.audit.records.find((r) => r.class === "SessionLifecycle");
    assert.ok(auditRec !== undefined, "must write a SessionLifecycle audit record");
  });

  it("rendered string includes drained turn count", async () => {
    const { host } = mockHost({ extId: "save-and-close" });
    await contract.lifecycle.init!(host, {});
    injectDrainContext(host, successDrain({ drainedTurns: 3, sessionPath: "" }));

    const result = await contract.execute(EMPTY_ARGS, host);
    assert.ok(result.rendered.includes("3"), "rendered must mention the drained turn count");
  });
});

// ---------------------------------------------------------------------------
// Drain timeout tests
// ---------------------------------------------------------------------------

describe("/save-and-close command — drain timeout", () => {
  it("returns persisted=false on drain timeout", async () => {
    const { host } = mockHost({ extId: "save-and-close" });
    await contract.lifecycle.init!(host, { drainTimeoutMs: 10 });

    const stalled = stalledDrain();
    injectDrainContext(host, stalled.ctx);

    const result = await contract.execute(EMPTY_ARGS, host);

    // Clean up the stalled drain to avoid a dangling promise.
    stalled.resolve();

    const payload = result.payload as unknown as SaveAndCloseResult;
    assert.equal(payload.persisted, false);
    assert.equal(payload.drainedTurns, 0);
  });

  it("emits save-and-close-timeout audit record on timeout", async () => {
    const { host, recorders } = mockHost({ extId: "save-and-close" });
    await contract.lifecycle.init!(host, { drainTimeoutMs: 10 });

    const stalled = stalledDrain();
    injectDrainContext(host, stalled.ctx);

    await contract.execute(EMPTY_ARGS, host);
    stalled.resolve();

    const timeoutRec = recorders.audit.records.find((r) => r.class === "save-and-close-timeout");
    assert.ok(timeoutRec !== undefined, "must emit a save-and-close-timeout audit record");
  });

  it("still emits SessionExitRequested (forced=true) on timeout", async () => {
    const { host, recorders } = mockHost({ extId: "save-and-close" });
    await contract.lifecycle.init!(host, { drainTimeoutMs: 10 });

    const stalled = stalledDrain();
    injectDrainContext(host, stalled.ctx);

    await contract.execute(EMPTY_ARGS, host);
    stalled.resolve();

    const exitEvent = recorders.events.records.find((r) => r.type === "SessionExitRequested");
    assert.ok(exitEvent !== undefined, "SessionExitRequested must be emitted even on timeout");
    assert.equal((exitEvent.payload as { forced?: boolean }).forced, true);
  });
});

// ---------------------------------------------------------------------------
// Store failure tests
// ---------------------------------------------------------------------------

describe("/save-and-close command — store unavailable", () => {
  it("propagates Session/StoreUnavailable when the final write fails", async () => {
    const { host } = mockHost({ extId: "save-and-close" });
    await contract.lifecycle.init!(host, {});
    injectDrainContext(host, unavailableDrain());

    await assert.rejects(
      () => contract.execute(EMPTY_ARGS, host),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null, "error must be an object");
        assert.equal((err as { class?: unknown }).class, "Session");
        assert.equal((err as { context?: { code?: unknown } }).context?.code, "StoreUnavailable");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Lifecycle and safety tests
// ---------------------------------------------------------------------------

describe("/save-and-close command — lifecycle", () => {
  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "save-and-close" });
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });

  it("runs lifecycle in order without error", async () => {
    const { host } = mockHost({ extId: "save-and-close" });
    const order: string[] = [];

    await contract.lifecycle.init!(host, {});
    order.push("init");
    await contract.lifecycle.dispose!(host);
    order.push("dispose");

    assert.deepEqual(order, ["init", "dispose"]);
  });

  it("throws ExtensionHost/LifecycleFailure when execute is called without init", async () => {
    const { host } = mockHost({ extId: "save-and-close" });

    await assert.rejects(
      () => contract.execute(EMPTY_ARGS, host),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "ExtensionHost");
        assert.equal((err as { context?: { code?: unknown } }).context?.code, "LifecycleFailure");
        return true;
      },
    );
  });
});
