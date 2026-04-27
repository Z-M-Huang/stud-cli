/**
 * Tests for `mockHost` — the frozen per-extension HostAPI stub.
 *
 * Covers:
 *    — cross-extension state-slot access throws ExtensionHost/SlotAccessDenied
 *             and emits a StateSlotAccessDenied audit record.
 *   Invariant #2 — no bulk-env surface (`list`/`all`/`entries`) on host.env.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExtensionHost, Validation } from "../../src/core/errors/index.js";

import { mockHost } from "./mock-host.js";

// ---------------------------------------------------------------------------
// Shape and session identity
// ---------------------------------------------------------------------------

describe("mockHost — shape", () => {
  it("returns a frozen host bound to the caller extId", () => {
    const { host } = mockHost({ extId: "ext-a" });
    assert.ok(Object.isFrozen(host), "host must be frozen");
    assert.ok(host.session.id.length > 0, "session.id must be non-empty");
  });

  it("session.mode defaults to 'ask'", () => {
    const { host } = mockHost({ extId: "ext-a" });
    assert.equal(host.session.mode, "ask");
  });

  it("session.mode reflects the provided option", () => {
    const { host } = mockHost({ extId: "ext-a", mode: "yolo" });
    assert.equal(host.session.mode, "yolo");
  });

  it("session.projectRoot defaults to the fake path", () => {
    const { host } = mockHost({ extId: "ext-a" });
    assert.ok(host.session.projectRoot.length > 0);
  });

  it("session.projectRoot reflects the provided option", () => {
    const { host } = mockHost({ extId: "ext-a", projectRoot: "/my/project/.stud" });
    assert.equal(host.session.projectRoot, "/my/project/.stud");
  });
});

// ---------------------------------------------------------------------------
// State slot — own extId
// ---------------------------------------------------------------------------

describe("mockHost — state slot (own extId)", () => {
  it("returns null from read() when no initialState is provided", async () => {
    const { host } = mockHost({ extId: "ext-a" });
    const slot = host.session.stateSlot("ext-a");
    const result = await slot.read();
    assert.equal(result, null);
  });

  it("returns the initialState on first read()", async () => {
    const { host } = mockHost({ extId: "ext-a", initialState: { seen: 0 } });
    const slot = host.session.stateSlot("ext-a");
    const before = await slot.read();
    assert.notEqual(before, null);
    assert.equal((before as { seen: number }).seen, 0);
  });

  it("write() followed by read() returns the new state", async () => {
    const { host } = mockHost({ extId: "ext-a", initialState: { seen: 0 } });
    const slot = host.session.stateSlot("ext-a");
    await slot.write({ seen: 1 });
    const after = await slot.read();
    assert.equal((after as { seen: number }).seen, 1);
  });

  it("state slot handle is callable multiple times (idempotent read)", async () => {
    const { host } = mockHost({ extId: "ext-a", initialState: { x: 42 } });
    const slot = host.session.stateSlot("ext-a");
    const r1 = await slot.read();
    const r2 = await slot.read();
    assert.deepEqual(r1, r2);
  });
});

// ---------------------------------------------------------------------------
// State slot — cross-extension access denied
// ---------------------------------------------------------------------------

describe("mockHost — state slot cross-slot rejection", () => {
  it("throws ExtensionHost/SlotAccessDenied for a different extId", () => {
    const { host } = mockHost({ extId: "ext-a" });
    assert.throws(
      () => {
        host.session.stateSlot("ext-b");
      },
      (err: unknown) => {
        assert.ok(err instanceof ExtensionHost, "must be ExtensionHost");
        assert.equal(err.code, "SlotAccessDenied");
        return true;
      },
    );
  });

  it("emits a StateSlotAccessDenied audit record before throwing", () => {
    const { host, recorders } = mockHost({ extId: "ext-a" });

    try {
      host.session.stateSlot("ext-b");
    } catch {
      // expected
    }

    const denied = recorders.audit.records.find((r) => r.class === "StateSlotAccessDenied");
    assert.ok(denied !== undefined, "audit record must be written");
    assert.equal(denied.extId, "ext-a");
    assert.equal((denied.payload as { requestedExtId: string }).requestedExtId, "ext-b");
  });

  it("each cross-slot attempt appends a separate audit record", () => {
    const { host, recorders } = mockHost({ extId: "ext-a" });

    try {
      host.session.stateSlot("ext-b");
    } catch {
      /* expected */
    }
    try {
      host.session.stateSlot("ext-c");
    } catch {
      /* expected */
    }

    const denied = recorders.audit.records.filter((r) => r.class === "StateSlotAccessDenied");
    assert.equal(denied.length, 2);
  });
});

// ---------------------------------------------------------------------------
// EnvAPI
// ---------------------------------------------------------------------------

describe("mockHost — env.get", () => {
  it("resolves a declared env var", async () => {
    const { host } = mockHost({ extId: "ext-a", env: { FOO: "bar" } });
    const value = await host.env.get("FOO");
    assert.equal(value, "bar");
  });

  it("throws Validation/EnvNameNotSet for an undeclared name", async () => {
    const { host } = mockHost({ extId: "ext-a", env: { FOO: "bar" } });
    await assert.rejects(
      async () => host.env.get("MISSING"),
      (err: unknown) => {
        assert.ok(err instanceof Validation, "must be Validation");
        assert.equal(err.code, "EnvNameNotSet");
        return true;
      },
    );
  });

  it("throws Validation/EnvNameNotSet when no env map is provided", async () => {
    const { host } = mockHost({ extId: "ext-a" });
    await assert.rejects(
      async () => host.env.get("ANY"),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.code, "EnvNameNotSet");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Invariant #2: no bulk env surface
// ---------------------------------------------------------------------------

describe("mockHost — no bulk env access (invariant #2)", () => {
  it("host.env does not expose 'list'", () => {
    const { host } = mockHost({ extId: "ext-a" });
    assert.ok(!("list" in (host.env as object)), "'list' must not exist on host.env");
  });

  it("host.env does not expose 'all'", () => {
    const { host } = mockHost({ extId: "ext-a" });
    assert.ok(!("all" in (host.env as object)), "'all' must not exist on host.env");
  });

  it("host.env does not expose 'entries'", () => {
    const { host } = mockHost({ extId: "ext-a" });
    assert.ok(!("entries" in (host.env as object)), "'entries' must not exist on host.env");
  });
});

// ---------------------------------------------------------------------------
// ConfigAPI — scope merge
// ---------------------------------------------------------------------------

describe("mockHost — config.readOwn scope merge", () => {
  it("returns empty object when no config is provided", async () => {
    const { host } = mockHost({ extId: "ext-a" });
    const cfg = await host.config.readOwn();
    assert.deepEqual(cfg, {});
  });

  it("merges bundled → global → project (project wins)", async () => {
    const { host } = mockHost({
      extId: "ext-a",
      config: {
        bundled: { a: 1, b: "bundled" },
        global: { b: "global", c: 2 },
        project: { c: 99, d: "project" },
      },
    });
    const cfg = await host.config.readOwn();
    assert.equal(cfg["a"], 1);
    assert.equal(cfg["b"], "global"); // global overrides bundled
    assert.equal(cfg["c"], 99); // project overrides global
    assert.equal(cfg["d"], "project");
  });

  it("returns a frozen config object", async () => {
    const { host } = mockHost({ extId: "ext-a", config: { bundled: { x: 1 } } });
    const cfg = await host.config.readOwn();
    assert.ok(Object.isFrozen(cfg));
  });
});

// ---------------------------------------------------------------------------
// EventsAPI — emit records to recorders.events
// ---------------------------------------------------------------------------

describe("mockHost — events.emit records", () => {
  it("emit appends to recorders.events.records", () => {
    const { host, recorders } = mockHost({ extId: "ext-a" });
    host.events.emit("MyEvent", { key: "value" });
    assert.equal(recorders.events.records.length, 1);
    const rec = recorders.events.records[0];
    assert.ok(rec !== undefined);
    assert.equal(rec.type, "MyEvent");
    assert.deepEqual(rec.payload, { key: "value" });
  });

  it("multiple emits append in FIFO order", () => {
    const { host, recorders } = mockHost({ extId: "ext-a" });
    host.events.emit("A", {});
    host.events.emit("B", {});
    host.events.emit("C", {});
    assert.equal(recorders.events.records.length, 3);
    assert.equal(recorders.events.records[0]?.type, "A");
    assert.equal(recorders.events.records[1]?.type, "B");
    assert.equal(recorders.events.records[2]?.type, "C");
  });
});

// ---------------------------------------------------------------------------
// AuditAPI — write records to recorders.audit
// ---------------------------------------------------------------------------

describe("mockHost — audit.write records", () => {
  it("write appends to recorders.audit.records with extId", async () => {
    const { host, recorders } = mockHost({ extId: "ext-x" });
    await host.audit.write({ severity: "info", code: "TestEvent", message: "hello" });
    assert.equal(recorders.audit.records.length, 1);
    const rec = recorders.audit.records[0];
    assert.ok(rec !== undefined);
    assert.equal(rec.class, "TestEvent");
    assert.equal(rec.extId, "ext-x");
    assert.equal((rec.payload as { message: string }).message, "hello");
  });
});
