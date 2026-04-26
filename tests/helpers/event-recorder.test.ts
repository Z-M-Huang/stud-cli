/**
 * Tests for `createEventRecorder` and `createAuditRecorder`.
 *
 * Covers:
 *   - FIFO ordering of pushed records.
 *   - `snapshot()` returns a stable copy.
 *   - `clear()` empties the records.
 *   - Audit recorder preserves `class` and `extId` on each record.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAuditRecorder, createEventRecorder } from "./event-recorder.js";

import type { AuditRecord, EventRecord } from "./event-recorder.js";

// Internal push accessor types used in these tests only
interface WithEventPush {
  push(record: EventRecord): void;
}
interface WithAuditPush {
  push(record: AuditRecord): void;
}

// ---------------------------------------------------------------------------
// EventRecorder
// ---------------------------------------------------------------------------

describe("createEventRecorder — shape", () => {
  it("starts with an empty records array", () => {
    const rec = createEventRecorder();
    assert.equal(rec.records.length, 0);
  });

  it("snapshot() returns empty array initially", () => {
    const rec = createEventRecorder();
    const snap = rec.snapshot();
    assert.equal(snap.length, 0);
  });
});

describe("createEventRecorder — push and FIFO ordering", () => {
  it("push appends a record and records.length increases", () => {
    const rec = createEventRecorder();
    const push = (rec as unknown as WithEventPush).push.bind(rec);
    push({ type: "A", payload: {}, at: 1 });
    assert.equal(rec.records.length, 1);
  });

  it("records are returned in FIFO order", () => {
    const rec = createEventRecorder();
    const push = (rec as unknown as WithEventPush).push.bind(rec);
    push({ type: "A", payload: {}, at: 1 });
    push({ type: "B", payload: {}, at: 2 });
    push({ type: "C", payload: {}, at: 3 });
    assert.equal(rec.records.length, 3);
    assert.equal(rec.records[0]?.type, "A");
    assert.equal(rec.records[1]?.type, "B");
    assert.equal(rec.records[2]?.type, "C");
  });

  it("snapshot() returns a stable copy independent of future pushes", () => {
    const rec = createEventRecorder();
    const push = (rec as unknown as WithEventPush).push.bind(rec);
    push({ type: "A", payload: {}, at: 1 });
    const snap = rec.snapshot();
    push({ type: "B", payload: {}, at: 2 });
    // snapshot taken before second push must still have length 1
    assert.equal(snap.length, 1);
    assert.equal(rec.records.length, 2);
  });

  it("payload is preserved verbatim", () => {
    const rec = createEventRecorder();
    const push = (rec as unknown as WithEventPush).push.bind(rec);
    const payload = { foo: "bar", count: 42 };
    push({ type: "X", payload, at: 10 });
    assert.deepEqual(rec.records[0]?.payload, payload);
  });

  it("at timestamp is preserved verbatim", () => {
    const rec = createEventRecorder();
    const push = (rec as unknown as WithEventPush).push.bind(rec);
    push({ type: "X", payload: {}, at: 999 });
    assert.equal(rec.records[0]?.at, 999);
  });
});

describe("createEventRecorder — clear", () => {
  it("clear() empties the records array", () => {
    const rec = createEventRecorder();
    const push = (rec as unknown as WithEventPush).push.bind(rec);
    push({ type: "A", payload: {}, at: 1 });
    push({ type: "B", payload: {}, at: 2 });
    assert.equal(rec.records.length, 2);
    rec.clear();
    assert.equal(rec.records.length, 0);
  });

  it("clear() is idempotent on an already-empty recorder", () => {
    const rec = createEventRecorder();
    rec.clear();
    rec.clear();
    assert.equal(rec.records.length, 0);
  });
});

// ---------------------------------------------------------------------------
// AuditRecorder
// ---------------------------------------------------------------------------

describe("createAuditRecorder — shape", () => {
  it("starts with an empty records array", () => {
    const rec = createAuditRecorder();
    assert.equal(rec.records.length, 0);
  });
});

describe("createAuditRecorder — push and field preservation", () => {
  it("push appends a record", () => {
    const rec = createAuditRecorder();
    const push = (rec as unknown as WithAuditPush).push.bind(rec);
    push({ class: "Approval", extId: "ext-a", payload: {}, at: 1 });
    assert.equal(rec.records.length, 1);
  });

  it("preserves class field", () => {
    const rec = createAuditRecorder();
    const push = (rec as unknown as WithAuditPush).push.bind(rec);
    push({ class: "Approval", extId: "ext-a", payload: {}, at: 1 });
    assert.equal(rec.records[0]?.class, "Approval");
  });

  it("preserves extId field", () => {
    const rec = createAuditRecorder();
    const push = (rec as unknown as WithAuditPush).push.bind(rec);
    push({ class: "Approval", extId: "ext-a", payload: {}, at: 1 });
    assert.equal(rec.records[0]?.extId, "ext-a");
  });

  it("preserves payload field", () => {
    const rec = createAuditRecorder();
    const push = (rec as unknown as WithAuditPush).push.bind(rec);
    const payload = { detail: "info" };
    push({ class: "ConfigLoaded", extId: "ext-b", payload, at: 5 });
    assert.deepEqual(rec.records[0]?.payload, payload);
  });

  it("records are returned in FIFO order", () => {
    const rec = createAuditRecorder();
    const push = (rec as unknown as WithAuditPush).push.bind(rec);
    push({ class: "X", extId: "a", payload: {}, at: 1 });
    push({ class: "Y", extId: "b", payload: {}, at: 2 });
    assert.equal(rec.records[0]?.class, "X");
    assert.equal(rec.records[1]?.class, "Y");
  });
});

describe("createAuditRecorder — snapshot and clear", () => {
  it("snapshot() returns a stable copy", () => {
    const rec = createAuditRecorder();
    const push = (rec as unknown as WithAuditPush).push.bind(rec);
    push({ class: "A", extId: "e", payload: {}, at: 1 });
    const snap = rec.snapshot();
    push({ class: "B", extId: "e", payload: {}, at: 2 });
    assert.equal(snap.length, 1);
  });

  it("clear() empties the records", () => {
    const rec = createAuditRecorder();
    const push = (rec as unknown as WithAuditPush).push.bind(rec);
    push({ class: "A", extId: "e", payload: {}, at: 1 });
    rec.clear();
    assert.equal(rec.records.length, 0);
  });
});
