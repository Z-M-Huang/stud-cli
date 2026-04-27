/**
 * Contract conformance tests for the observer-example reference hook.
 *
 * Exercises: shape assertions, duration recording, SlowTool event emission,
 * read-only no-op, config validation, and idempotent dispose.
 *
 * Uses node:test + node:assert/strict (project canonical test runner).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contract } from "../../../../src/extensions/hooks/observer-example/index.js";
import { mockHost } from "../../../helpers/mock-host.js";

import type { ObserverHandler } from "../../../../src/contracts/hooks.js";
import type {
  ToolCallPostPayload,
  ToolDurationRecord,
} from "../../../../src/extensions/hooks/observer-example/index.js";

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

type ObserverFn = ObserverHandler<ToolCallPostPayload>;

function callObserve(
  host: ReturnType<typeof mockHost>["host"],
  payload: ToolCallPostPayload,
): Promise<void> {
  return (contract.handler as ObserverFn)(payload, host);
}

function makePayload(opts: {
  toolId?: string;
  invocationId?: string;
  startedAt: bigint;
  endedAt: bigint;
}): ToolCallPostPayload {
  return {
    toolId: opts.toolId ?? "bash",
    invocationId: opts.invocationId ?? "i1",
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
  };
}

// ---------------------------------------------------------------------------
// Shape / contract declaration tests
// ---------------------------------------------------------------------------

describe("observer-example hook — shape", () => {
  it("declares Hook category", () => {
    assert.equal(contract.kind, "Hook");
  });

  it("declares observer sub-kind", () => {
    assert.equal(contract.registration.subKind, "observer");
  });

  it("attaches to TOOL_CALL/post slot with per-call firing mode", () => {
    assert.equal(contract.registration.slot, "TOOL_CALL/post");
    assert.equal(contract.registration.firingMode, "per-call");
  });

  it("declares a semver contractVersion", () => {
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
  });

  it("declares a non-empty requiredCoreVersion range", () => {
    assert.ok(contract.requiredCoreVersion.length > 0);
  });

  it("declares a state slot with slotVersion", () => {
    assert.ok(contract.stateSlot !== null);
    assert.match(contract.stateSlot.slotVersion, /^\d+\.\d+\.\d+$/);
  });

  it("has a parseable configSchema", () => {
    assert.equal(typeof contract.configSchema, "object");
    assert.equal((contract.configSchema as { type?: string }).type, "object");
  });
});

// ---------------------------------------------------------------------------
// Observer behavior tests —
// ---------------------------------------------------------------------------

describe("observer-example hook — behavior", () => {
  it("records duration keyed by (toolId, invocationId)", async () => {
    const { host } = mockHost({ extId: "observer-example" });
    await contract.lifecycle.init!(host, {});

    // 150_000_000 ns = 150 ms
    const payload = makePayload({ startedAt: 100_000_000n, endedAt: 250_000_000n });
    await callObserve(host, payload);

    const rawState = await host.session.stateSlot("observer-example").read();
    assert.ok(rawState !== null, "state slot should be written");

    const records = (rawState as { records: ToolDurationRecord[] }).records;
    assert.equal(records.length, 1);
    const r0 = records[0];
    assert.ok(r0 !== undefined, "first record should exist");
    assert.equal(r0.toolId, "bash");
    assert.equal(r0.invocationId, "i1");
    assert.equal(r0.durationMs, 150);
  });

  it("accumulates multiple records across calls", async () => {
    const { host } = mockHost({ extId: "observer-example" });
    await contract.lifecycle.init!(host, {});

    await callObserve(host, makePayload({ startedAt: 0n, endedAt: 100_000_000n }));
    await callObserve(
      host,
      makePayload({ invocationId: "i2", startedAt: 200_000_000n, endedAt: 500_000_000n }),
    );

    const rawState = await host.session.stateSlot("observer-example").read();
    assert.ok(rawState !== null);
    const records = (rawState as { records: ToolDurationRecord[] }).records;
    assert.equal(records.length, 2);
    const r0 = records[0];
    const r1 = records[1];
    assert.ok(r0 !== undefined, "first record should exist");
    assert.ok(r1 !== undefined, "second record should exist");
    assert.equal(r0.durationMs, 100);
    assert.equal(r1.durationMs, 300);
  });

  it("emits SlowTool event when duration exceeds default threshold (5000 ms)", async () => {
    const { host, recorders } = mockHost({ extId: "observer-example" });
    await contract.lifecycle.init!(host, {});

    // 6_000_000_000 ns = 6000 ms > 5000 ms threshold
    const payload = makePayload({ startedAt: 0n, endedAt: 6_000_000_000n });
    await callObserve(host, payload);

    const slowEvents = recorders.events.records.filter((e) => e.type === "SlowTool");
    assert.equal(slowEvents.length, 1);
    const firstSlow = slowEvents[0];
    assert.ok(firstSlow !== undefined, "SlowTool event should exist");
    assert.equal((firstSlow.payload as { toolId: string }).toolId, "bash");
  });

  it("emits SlowTool event when duration exceeds configured threshold", async () => {
    const { host, recorders } = mockHost({ extId: "observer-example" });
    await contract.lifecycle.init!(host, { slowToolThresholdMs: 1000 });

    // 2_000_000_000 ns = 2000 ms > 1000 ms threshold
    const payload = makePayload({ startedAt: 0n, endedAt: 2_000_000_000n });
    await callObserve(host, payload);

    const slowEvents = recorders.events.records.filter((e) => e.type === "SlowTool");
    assert.equal(slowEvents.length, 1);
  });

  it("does NOT emit SlowTool when duration is below threshold", async () => {
    const { host, recorders } = mockHost({ extId: "observer-example" });
    await contract.lifecycle.init!(host, {});

    // 150 ms — well below 5000 ms default
    const payload = makePayload({ startedAt: 100_000_000n, endedAt: 250_000_000n });
    await callObserve(host, payload);

    const slowEvents = recorders.events.records.filter((e) => e.type === "SlowTool");
    assert.equal(slowEvents.length, 0);
  });

  it("is read-only — returns void (undefined), never mutates the payload", async () => {
    const { host } = mockHost({ extId: "observer-example" });
    await contract.lifecycle.init!(host, {});

    const payload = makePayload({ startedAt: 0n, endedAt: 100_000_000n });
    const outcome = await callObserve(host, payload);

    assert.equal(outcome, undefined);
  });
});

// ---------------------------------------------------------------------------
// Config-validation + lifecycle tests
// ---------------------------------------------------------------------------

describe("observer-example hook — lifecycle", () => {
  it("throws Validation/ConfigSchemaViolation on negative slowToolThresholdMs", async () => {
    const { host } = mockHost({ extId: "observer-example" });

    await assert.rejects(
      () => contract.lifecycle.init!(host, { slowToolThresholdMs: -10 }),
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

  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "observer-example" });
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });

  it("runs lifecycle in order without error", async () => {
    const { host } = mockHost({ extId: "observer-example" });
    const order: string[] = [];

    await contract.lifecycle.init!(host, {});
    order.push("init");
    await contract.lifecycle.dispose!(host);
    order.push("dispose");

    assert.deepEqual(order, ["init", "dispose"]);
  });

  it("works without init (uses defaults)", async () => {
    // Observer should degrade gracefully if init was never called.
    // Default threshold applies; no crash.
    const { host } = mockHost({ extId: "observer-example" });
    const payload = makePayload({ startedAt: 0n, endedAt: 100_000_000n });
    await assert.doesNotReject(() => callObserve(host, payload));
  });
});
