/**
 * Tests for the three per-extension host wrapper factories:
 *   createHostEvents, createHostAudit, createHostInteraction
 *
 * Covers:
 *   AC-56 — returned objects are Object.freeze'd (shape cannot grow at runtime)
 *   AC-56 — bus pass-through (emit reaches bus subscribers)
 *   AC-56 — extId plumbing (every record / request carries the extension id)
 *
 * Wiki: core/Host-API.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEventBus } from "../../../../src/core/events/bus.js";
import { createHostAudit } from "../../../../src/core/host/impl/audit.js";
import { createHostEvents } from "../../../../src/core/host/impl/events.js";
import { createHostInteraction } from "../../../../src/core/host/impl/interaction.js";

// ---------------------------------------------------------------------------
// createHostEvents
// ---------------------------------------------------------------------------

describe("createHostEvents", () => {
  it("returns a frozen object that cannot grow new methods (AC-56)", () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const he = createHostEvents({ bus, extId: "ext.a" });

    assert.equal(Object.isFrozen(he), true);

    let thrown = false;
    try {
      (he as unknown as Record<string, unknown>)["newMethod"] = () => {
        // noop — just testing that assignment throws on frozen object
      };
    } catch {
      thrown = true;
    }
    assert.equal(
      thrown,
      true,
      "assigning a new property to a frozen object must throw in strict mode",
    );
  });

  it("delivers emits into the underlying bus (AC-56 pass-through)", () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const he = createHostEvents({ bus, extId: "ext.a" });

    const seen: unknown[] = [];
    bus.on("MyEvent", (ev) => seen.push(ev));
    he.emit("MyEvent", { ok: true });

    assert.equal(seen.length, 1);
  });

  it("encodes extId in the correlationId of every emitted envelope", () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const he = createHostEvents({ bus, extId: "ext.a" });

    let correlationId: string | undefined;
    bus.on("Ping", (ev) => {
      correlationId = ev.correlationId;
    });

    he.emit("Ping", {});

    assert.ok(correlationId !== undefined, "handler should have been called");
    assert.ok(
      correlationId.startsWith("ext.a:"),
      `correlationId "${correlationId}" must start with the extId prefix "ext.a:"`,
    );
  });

  it("on is a passthrough to the underlying bus", () => {
    const bus = createEventBus({ monotonic: () => 0n });
    const he = createHostEvents({ bus, extId: "ext.b" });

    // Subscribe via the host wrapper; emit directly on the bus.
    const seen: unknown[] = [];
    he.on("Direct", (ev) => seen.push(ev));
    bus.emit({ name: "Direct", correlationId: "c1", monotonicTs: 1n, payload: { x: 1 } });

    assert.equal(seen.length, 1);
  });
});

// ---------------------------------------------------------------------------
// createHostAudit
// ---------------------------------------------------------------------------

describe("createHostAudit", () => {
  it("returns a frozen object (AC-56)", () => {
    const ha = createHostAudit({
      auditWriter: (_e) => {
        // noop — just testing freeze
      },
      extId: "ext.a",
    });
    assert.equal(Object.isFrozen(ha), true);
  });

  it("attaches extId to every audit record (AC-56 extId plumbing)", () => {
    const entries: Record<string, unknown>[] = [];
    const ha = createHostAudit({
      auditWriter: (e) => entries.push(e as unknown as Record<string, unknown>),
      extId: "ext.a",
    });

    ha.record({ class: "Operation", code: "Started", data: {} });

    assert.equal(entries.length, 1);
    assert.equal(entries[0]!["extId"], "ext.a");
  });

  it("stamps monotonicTs as a bigint on every audit record", () => {
    const entries: Record<string, unknown>[] = [];
    const ha = createHostAudit({
      auditWriter: (e) => entries.push(e as unknown as Record<string, unknown>),
      extId: "ext.c",
    });

    ha.record({ class: "Lifecycle", code: "Init", data: { detail: "x" } });

    assert.equal(typeof entries[0]!["monotonicTs"], "bigint");
  });

  it("forwards class, code, and data unchanged", () => {
    const entries: Record<string, unknown>[] = [];
    const ha = createHostAudit({
      auditWriter: (e) => entries.push(e as unknown as Record<string, unknown>),
      extId: "ext.d",
    });

    const data = { key: "value" } as const;
    ha.record({ class: "Security", code: "Denied", data });

    assert.equal(entries[0]!["class"], "Security");
    assert.equal(entries[0]!["code"], "Denied");
    assert.deepEqual(entries[0]!["data"], data);
  });
});

// ---------------------------------------------------------------------------
// createHostInteraction
// ---------------------------------------------------------------------------

describe("createHostInteraction", () => {
  it("returns a frozen object (AC-56)", () => {
    const hi = createHostInteraction({
      arbiter: (_k, _s, _id) => Promise.resolve({ accepted: true }),
      extId: "ext.a",
    });
    assert.equal(Object.isFrozen(hi), true);
  });

  it("forwards to the arbiter with the caller extId (AC-56 extId plumbing)", async () => {
    let capturedId = "";
    const hi = createHostInteraction({
      arbiter: (_k, _s, id) => {
        capturedId = id;
        return Promise.resolve({ accepted: true });
      },
      extId: "ext.b",
    });

    await hi.request("Ask", { prompt: "x" });

    assert.equal(capturedId, "ext.b");
  });

  it("returns the arbiter response verbatim", async () => {
    const hi = createHostInteraction({
      arbiter: () => Promise.resolve({ accepted: false, data: { reason: "denied" } }),
      extId: "ext.e",
    });

    const result = await hi.request("Confirm", {});

    assert.equal(result.accepted, false);
    assert.deepEqual(result.data, { reason: "denied" });
  });

  it("propagates arbiter rejections to the caller", async () => {
    const err = new Error("arbiter unavailable");
    const hi = createHostInteraction({
      arbiter: () => Promise.reject(err),
      extId: "ext.f",
    });

    await assert.rejects(async () => hi.request("Confirm", {}), /arbiter unavailable/);
  });
});
