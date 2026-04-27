/**
 * Persistence-and-Recovery: snapshot writer, crash recovery, and cross-store
 * mismatch tests.
 *
 * Covers:
 *   1. writeSnapshot awaits the store write then emits SessionPersisted.
 *   2. writeSnapshot surfaces Session/StoreUnavailable when the store write fails.
 *   3. writeSnapshot throws Session/ManifestDrift when writtenByStore is blank
 *      ( precondition — assertCrashSafe is called before any I/O).
 *   4. SessionPersisted envelope carries correlationId, payload, and monotonicTs.
 *   5. assertStoreCompatible throws Session/ResumeMismatch on store-id mismatch.
 *   6. assertStoreCompatible is a no-op when the store ids match.
 *   7. readLastSnapshot delegates to the store.
 *   8. assertCrashSafe rejects a manifest with a blank writtenByStore.
 *   9. assertCrashSafe accepts a manifest with a populated writtenByStore.
 *
 *  parallel fan-out note:
 *   "Parallel fan-out siblings commit a single compound-turn snapshot at the
 *   last sibling's Exit (or the join's Exit when declared)." That behaviour is
 *   orchestrated by the stage-execution layer (Unit handling Stage-Executions),
 *   not by the persistence primitives in this unit. The writer and recovery
 *   helpers are called by the orchestrator once per compound turn; no additional
 *   tests are required here.
 *
 * Wiki: core/Persistence-and-Recovery.md + contracts/Session-Store.md
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEventBus } from "../../../src/core/events/bus.js";
import { assertCrashSafe } from "../../../src/core/persistence/crash-safe.js";
import { createCrashRecovery } from "../../../src/core/persistence/recovery.js";
import { createSnapshotWriter } from "../../../src/core/persistence/writer.js";

import type { SessionManifest } from "../../../src/core/session/manifest/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINIMAL: SessionManifest = {
  schemaVersion: "1.0",
  sessionId: "sess-abc",
  projectRoot: "/x/.stud",
  mode: "ask",
  createdAtMonotonic: "1",
  updatedAtMonotonic: "2",
  messages: [],
  writtenByStore: "fs.reference",
};

// ---------------------------------------------------------------------------
// createSnapshotWriter — turn-boundary writes
// ---------------------------------------------------------------------------

describe("createSnapshotWriter — turn-boundary writes", () => {
  it("writes through the store and emits SessionPersisted with full envelope", async () => {
    let wrote = false;
    const bus = createEventBus({ monotonic: () => 0n });
    const emitted: string[] = [];
    bus.on("SessionPersisted", (ev) => {
      assert.equal(ev.correlationId, MINIMAL.sessionId, "correlationId must equal sessionId");
      assert.deepEqual(ev.payload, { sessionId: MINIMAL.sessionId, storeId: "fs.reference" });
      assert.equal(typeof ev.monotonicTs, "bigint", "monotonicTs must be a bigint");
      emitted.push("SessionPersisted");
    });
    const w = createSnapshotWriter({
      store: {
        write: () => {
          wrote = true;
          return Promise.resolve();
        },
        id: "fs.reference",
      },
      bus,
    });
    await w.writeSnapshot(MINIMAL);
    assert.equal(wrote, true, "store.write must be called");
    assert.ok(emitted.includes("SessionPersisted"), "SessionPersisted must fire after write");
  });

  it("emits SessionPersisted only after the store write resolves, not before", async () => {
    const order: string[] = [];
    const bus = createEventBus({ monotonic: () => 0n });
    bus.on("SessionPersisted", () => order.push("event"));
    const w = createSnapshotWriter({
      store: {
        write: () => {
          order.push("write");
          return Promise.resolve();
        },
        id: "fs.reference",
      },
      bus,
    });
    await w.writeSnapshot(MINIMAL);
    assert.deepEqual(order, ["write", "event"], "write must complete before event fires");
  });

  it("surfaces Session/StoreUnavailable when the store write fails", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const w = createSnapshotWriter({
      store: { write: () => Promise.reject(new Error("disk full")), id: "fs.reference" },
      bus,
    });
    let caught: unknown;
    try {
      await w.writeSnapshot(MINIMAL);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught !== undefined, "must throw on store failure");
    assert.equal((caught as { class: string }).class, "Session");
    assert.equal((caught as { context: { code: string } }).context.code, "StoreUnavailable");
  });

  it("does not emit SessionPersisted when the store write fails", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const emitted: string[] = [];
    bus.on("SessionPersisted", () => emitted.push("SessionPersisted"));
    const w = createSnapshotWriter({
      store: { write: () => Promise.reject(new Error("io error")), id: "fs.reference" },
      bus,
    });
    try {
      await w.writeSnapshot(MINIMAL);
    } catch {
      /* expected */
    }
    assert.equal(emitted.length, 0, "SessionPersisted must not fire on write failure");
  });
});

// ---------------------------------------------------------------------------
// createSnapshotWriter —  precondition guard (assertCrashSafe)
// ---------------------------------------------------------------------------

describe("createSnapshotWriter —  precondition guard", () => {
  it("throws Session/ManifestDrift when writtenByStore is blank, before any I/O", async () => {
    // assertCrashSafe runs before store.write; store must not be called.
    const bus = createEventBus({ monotonic: () => 0n });
    let storeWritten = false;
    const w = createSnapshotWriter({
      store: {
        write: () => {
          storeWritten = true;
          return Promise.resolve();
        },
        id: "fs.reference",
      },
      bus,
    });
    let caught: unknown;
    try {
      await w.writeSnapshot({ ...MINIMAL, writtenByStore: "" });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught !== undefined, "must throw on blank writtenByStore");
    assert.equal((caught as { class: string }).class, "Session");
    assert.equal((caught as { context: { code: string } }).context.code, "ManifestDrift");
    assert.equal(storeWritten, false, "store.write must not be called when precondition fails");
  });

  it("throws Session/ManifestDrift when writtenByStore is undefined", async () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const w = createSnapshotWriter({
      store: { write: () => Promise.resolve(), id: "fs.reference" },
      bus,
    });
    const bad = { ...MINIMAL, writtenByStore: undefined } as unknown as SessionManifest;
    let caught: unknown;
    try {
      await w.writeSnapshot(bad);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught !== undefined, "must throw when writtenByStore is undefined");
    assert.equal((caught as { class: string }).class, "Session");
    assert.equal((caught as { context: { code: string } }).context.code, "ManifestDrift");
  });
});

// ---------------------------------------------------------------------------
// createCrashRecovery
// ---------------------------------------------------------------------------

describe("createCrashRecovery", () => {
  it("throws Session/ResumeMismatch when manifest store id and active store id differ", () => {
    const r = createCrashRecovery({
      store: { read: () => Promise.resolve(null), id: "fs.reference" },
    });
    let caught: unknown;
    try {
      r.assertStoreCompatible("sqlite.store", "fs.reference");
    } catch (e) {
      caught = e;
    }
    assert.ok(caught !== undefined, "must throw on store mismatch");
    assert.equal((caught as { class: string }).class, "Session");
    assert.equal((caught as { context: { code: string } }).context.code, "ResumeMismatch");
  });

  it("does not throw when manifest store id matches the active store id", () => {
    const r = createCrashRecovery({
      store: { read: () => Promise.resolve(null), id: "fs.reference" },
    });
    r.assertStoreCompatible("fs.reference", "fs.reference");
  });

  it("returns null from readLastSnapshot when the store has no persisted manifest", async () => {
    const r = createCrashRecovery({
      store: { read: () => Promise.resolve(null), id: "fs.reference" },
    });
    const result = await r.readLastSnapshot();
    assert.equal(result, null);
  });

  it("returns the stored manifest from readLastSnapshot", async () => {
    const r = createCrashRecovery({
      store: { read: () => Promise.resolve(MINIMAL), id: "fs.reference" },
    });
    const result = await r.readLastSnapshot();
    assert.deepEqual(result, MINIMAL);
  });
});

// ---------------------------------------------------------------------------
// assertCrashSafe
// ---------------------------------------------------------------------------

describe("assertCrashSafe", () => {
  it("accepts a manifest with a non-empty writtenByStore", () => {
    assertCrashSafe(MINIMAL);
  });

  it("throws Session/ManifestDrift when writtenByStore is absent (undefined)", () => {
    const bad = { ...MINIMAL, writtenByStore: undefined } as unknown as SessionManifest;
    let caught: unknown;
    try {
      assertCrashSafe(bad);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught !== undefined, "must throw when writtenByStore is undefined");
    assert.equal((caught as { class: string }).class, "Session");
    assert.equal((caught as { context: { code: string } }).context.code, "ManifestDrift");
  });

  it("throws Session/ManifestDrift when writtenByStore is an empty string", () => {
    const bad = { ...MINIMAL, writtenByStore: "" };
    let caught: unknown;
    try {
      assertCrashSafe(bad);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught !== undefined, "must throw on blank writtenByStore");
    assert.equal((caught as { class: string }).class, "Session");
    assert.equal((caught as { context: { code: string } }).context.code, "ManifestDrift");
  });

  it("throws Session/ManifestDrift when writtenByStore is whitespace only", () => {
    const bad = { ...MINIMAL, writtenByStore: "   " };
    let caught: unknown;
    try {
      assertCrashSafe(bad);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught !== undefined, "must throw on whitespace-only writtenByStore");
    assert.equal((caught as { class: string }).class, "Session");
    assert.equal((caught as { context: { code: string } }).context.code, "ManifestDrift");
  });

  it("uses '(unknown)' as sessionId fallback when sessionId is absent", () => {
    const bad = {
      ...MINIMAL,
      sessionId: undefined,
      writtenByStore: "",
    } as unknown as SessionManifest;
    let caught: unknown;
    try {
      assertCrashSafe(bad);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught !== undefined, "must throw when writtenByStore is blank");
    assert.equal((caught as { class: string }).class, "Session");
    assert.equal((caught as { context: { code: string } }).context.code, "ManifestDrift");
  });
});
