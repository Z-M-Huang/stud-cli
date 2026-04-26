/**
 * Session resume orchestrator tests.
 *
 * Covers AC-45's revised semantics (Q-2 "always-core-works"):
 *   - Happy path: SM attach succeeds → smRestored true, no skip entries.
 *   - Silent SM skip: core resume succeeds even when the SM extension is absent.
 *   - SM attach throws: treated as a silent skip (Q-2 policy).
 *   - Absent smState: attachSm is never called; no skip entries; smRestored false.
 *   - Session/ResumeMismatch: thrown when the active store differs from the
 *     one that wrote the manifest (invariant #4 / AC-81).
 *   - Session/NoSnapshot: thrown when there is nothing to resume.
 *
 * Note on deliverSmSlots: slot delivery on the Resumed → Active edge is
 * the state machine's responsibility (wired at createSessionStateMachine
 * construction time, tested in transitions.test.ts). This unit verifies
 * that (a) the callback is invoked at least once when the lifecycle advances
 * to Active (spy test below) and (b) resumeSession drives the machine to
 * Active state (lifecycle state assertions).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEventBus } from "../../../src/core/events/bus.js";
import { resumeSession } from "../../../src/core/session-lifecycle/resume.js";
import { createSessionStateMachine } from "../../../src/core/session-lifecycle/transitions.js";

import type { SessionManifest } from "../../../src/core/session/manifest/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MANIFEST_WITH_SM: SessionManifest = {
  schemaVersion: "1.0",
  sessionId: "s1",
  projectRoot: "/x/.stud",
  mode: "ask",
  createdAtMonotonic: "1",
  updatedAtMonotonic: "2",
  messages: [{ id: "m1", role: "user", content: "hi", monotonicTs: "1" }],
  writtenByStore: "fs.reference",
  smState: { smExtId: "missing.sm", slotVersion: "1", slot: {} },
};

const MANIFEST_WITHOUT_SM: SessionManifest = {
  schemaVersion: "1.0",
  sessionId: "s3",
  projectRoot: "/z/.stud",
  mode: "ask",
  createdAtMonotonic: "3",
  updatedAtMonotonic: "4",
  messages: [],
  writtenByStore: "fs.reference",
};

const MANIFEST_THROW_SM: SessionManifest = {
  schemaVersion: "1.0",
  sessionId: "s2",
  projectRoot: "/y/.stud",
  mode: "yolo",
  createdAtMonotonic: "2",
  updatedAtMonotonic: "3",
  messages: [],
  writtenByStore: "fs.reference",
  smState: { smExtId: "bad.sm", slotVersion: "2", slot: null },
};

const MANIFEST_ACTIVE: SessionManifest = {
  schemaVersion: "1.0",
  sessionId: "s4",
  projectRoot: "/w/.stud",
  mode: "ask",
  createdAtMonotonic: "4",
  updatedAtMonotonic: "5",
  messages: [],
  writtenByStore: "fs.reference",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Advance a freshly-constructed machine (Idle) to Closed state. */
async function toClosedState(machine: ReturnType<typeof createSessionStateMachine>): Promise<void> {
  await machine.trigger({ kind: "FirstTurn" });
  await machine.trigger({ kind: "Snapshot" });
  await machine.trigger({ kind: "Sigterm" });
}

/** No-op deliverSmSlots stub. */
function noopDeliver(): Promise<void> {
  return Promise.resolve();
}

/** No-op assertStoreCompatible stub. */
function noopAssertCompat(_m: string, _a: string): void {
  return;
}

// ---------------------------------------------------------------------------
// Tests: SM attach success (happy path) — AC-45
// ---------------------------------------------------------------------------

describe("resumeSession — SM attach: success (AC-45)", () => {
  it("sets smRestored true and records no skip entries when attachSm returns 'attached'", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const machine = createSessionStateMachine({ bus, deliverSmSlots: noopDeliver });
    await toClosedState(machine);

    const recovery = {
      readLastSnapshot: () => Promise.resolve(MANIFEST_WITH_SM),
      assertStoreCompatible: noopAssertCompat,
    };

    const outcome = await resumeSession({
      recovery,
      activeStoreId: "fs.reference",
      lifecycleMachine: machine,
      attachSm: (_smExtId: string, _slot: unknown, _slotVersion: string) =>
        Promise.resolve("attached" as const),
    });

    assert.equal(
      outcome.smRestored,
      true,
      "smRestored must be true when attachSm returns 'attached'",
    );
    assert.equal(
      outcome.skippedExtensions.length,
      0,
      "no skip entries when SM was attached successfully",
    );
    assert.equal(machine.state(), "Active", "lifecycle machine must end in Active state");
  });

  it("invokes deliverSmSlots on the Resumed → Active edge", async () => {
    let deliverCalled = false;
    const bus = createEventBus({ monotonic: () => 0n });
    const machine = createSessionStateMachine({
      bus,
      deliverSmSlots: () => {
        deliverCalled = true;
        return Promise.resolve();
      },
    });
    await toClosedState(machine);

    await resumeSession({
      recovery: {
        readLastSnapshot: () => Promise.resolve(MANIFEST_ACTIVE),
        assertStoreCompatible: noopAssertCompat,
      },
      activeStoreId: "fs.reference",
      lifecycleMachine: machine,
      attachSm: (_smExtId: string, _slot: unknown, _slotVersion: string) =>
        Promise.resolve("attached" as const),
    });

    assert.equal(
      deliverCalled,
      true,
      "deliverSmSlots must be invoked on the Resumed → Active edge",
    );
    assert.equal(machine.state(), "Active");
  });
});

// ---------------------------------------------------------------------------
// Tests: SM skip cases
// ---------------------------------------------------------------------------

describe("resumeSession — SM skip: absent extension (AC-45 Q-2)", () => {
  it("restores messages and mode even when the SM extension is absent", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const machine = createSessionStateMachine({ bus, deliverSmSlots: noopDeliver });
    await toClosedState(machine);

    const recovery = {
      readLastSnapshot: () => Promise.resolve(MANIFEST_WITH_SM),
      assertStoreCompatible: noopAssertCompat,
    };

    const outcome = await resumeSession({
      recovery,
      activeStoreId: "fs.reference",
      lifecycleMachine: machine,
      attachSm: (_smExtId: string, _slot: unknown, _slotVersion: string) =>
        Promise.resolve("skipped" as const),
    });

    assert.equal(outcome.messages.length, 1, "message history must be restored");
    assert.equal(outcome.mode, "ask", "mode must be restored");
    assert.equal(outcome.projectRoot, "/x/.stud", "projectRoot must be restored");
    assert.equal(outcome.sessionId, "s1", "sessionId must be restored");
    assert.equal(outcome.smRestored, false, "smRestored must be false when SM is absent");
    assert.ok(outcome.skippedExtensions.length > 0, "skippedExtensions must record the missed SM");
    assert.equal(
      outcome.skippedExtensions[0]?.extId,
      "missing.sm",
      "skipped entry must name the SM extension",
    );
  });

  it("records a skip when attachSm throws", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const machine = createSessionStateMachine({ bus, deliverSmSlots: noopDeliver });
    await toClosedState(machine);

    const recovery = {
      readLastSnapshot: () => Promise.resolve(MANIFEST_THROW_SM),
      assertStoreCompatible: noopAssertCompat,
    };

    const outcome = await resumeSession({
      recovery,
      activeStoreId: "fs.reference",
      lifecycleMachine: machine,
      attachSm: (_smExtId: string, _slot: unknown, _slotVersion: string) =>
        Promise.reject(new Error("SM load failure")),
    });

    assert.equal(outcome.smRestored, false);
    assert.equal(outcome.skippedExtensions.length, 1);
    assert.equal(outcome.skippedExtensions[0]?.extId, "bad.sm");
  });
});

describe("resumeSession — SM skip: no smState in manifest (AC-45 Q-2)", () => {
  it("does not add a skippedExtensions entry when smState is absent", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const machine = createSessionStateMachine({ bus, deliverSmSlots: noopDeliver });
    await toClosedState(machine);

    let attachCalled = false;
    const outcome = await resumeSession({
      recovery: {
        readLastSnapshot: () => Promise.resolve(MANIFEST_WITHOUT_SM),
        assertStoreCompatible: noopAssertCompat,
      },
      activeStoreId: "fs.reference",
      lifecycleMachine: machine,
      attachSm: (_smExtId: string, _slot: unknown, _slotVersion: string) => {
        attachCalled = true;
        return Promise.resolve("attached" as const);
      },
    });

    assert.equal(attachCalled, false, "attachSm must not be called when smState is absent");
    assert.equal(outcome.skippedExtensions.length, 0, "no skip entries when no SM was expected");
    assert.equal(outcome.smRestored, false);
  });

  it("drives the lifecycle machine to Active state on successful resume", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const machine = createSessionStateMachine({ bus, deliverSmSlots: noopDeliver });
    await toClosedState(machine);

    await resumeSession({
      recovery: {
        readLastSnapshot: () => Promise.resolve(MANIFEST_ACTIVE),
        assertStoreCompatible: noopAssertCompat,
      },
      activeStoreId: "fs.reference",
      lifecycleMachine: machine,
      attachSm: (_smExtId: string, _slot: unknown, _slotVersion: string) =>
        Promise.resolve("attached" as const),
    });

    assert.equal(machine.state(), "Active", "lifecycle machine must end in Active state");
  });
});

// ---------------------------------------------------------------------------
// Tests: Session/ResumeMismatch
// ---------------------------------------------------------------------------

describe("resumeSession — Session/ResumeMismatch (AC-81)", () => {
  it("throws ResumeMismatch when the active store differs from the manifest store", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const machine = createSessionStateMachine({ bus, deliverSmSlots: noopDeliver });

    const mismatchManifest: SessionManifest = {
      schemaVersion: "1.0",
      sessionId: "s5",
      projectRoot: "/v/.stud",
      mode: "ask",
      createdAtMonotonic: "5",
      updatedAtMonotonic: "6",
      messages: [],
      writtenByStore: "sqlite.store",
    };

    const recovery = {
      readLastSnapshot: () => Promise.resolve(mismatchManifest),
      assertStoreCompatible: (manifestStoreId: string, activeStoreId: string): void => {
        if (manifestStoreId !== activeStoreId) {
          const e: Error & { class?: string; context?: { code: string } } = new Error("mismatch");
          e.class = "Session";
          e.context = { code: "ResumeMismatch" };
          throw e;
        }
      },
    };

    let err: unknown;
    try {
      await resumeSession({
        recovery,
        activeStoreId: "fs.reference",
        lifecycleMachine: machine,
        attachSm: (_smExtId: string, _slot: unknown, _slotVersion: string) =>
          Promise.resolve("skipped" as const),
      });
    } catch (e) {
      err = e;
    }

    assert.ok(err !== undefined, "must throw");
    assert.equal((err as { context: { code: string } }).context.code, "ResumeMismatch");
    assert.equal(machine.state(), "Idle", "lifecycle machine must not advance on mismatch");
  });
});

// ---------------------------------------------------------------------------
// Tests: Session/NoSnapshot
// ---------------------------------------------------------------------------

describe("resumeSession — Session/NoSnapshot", () => {
  it("throws NoSnapshot when the store has no snapshot", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const machine = createSessionStateMachine({ bus, deliverSmSlots: noopDeliver });

    let err: unknown;
    try {
      await resumeSession({
        recovery: {
          readLastSnapshot: () => Promise.resolve(null),
          assertStoreCompatible: noopAssertCompat,
        },
        activeStoreId: "fs.reference",
        lifecycleMachine: machine,
        attachSm: (_smExtId: string, _slot: unknown, _slotVersion: string) =>
          Promise.resolve("skipped" as const),
      });
    } catch (e) {
      err = e;
    }

    assert.ok(err !== undefined, "must throw");
    assert.equal((err as { context: { code: string } }).context.code, "NoSnapshot");
    assert.equal(machine.state(), "Idle", "lifecycle machine must not advance when no snapshot");
  });
});
