/**
 * Extension State contract tests.
 *
 * Verifies:
 *   1. verifyStateSlot — version match, unversioned slot, drift reject, drift warn,
 *      migrate success, migrator failure.
 *   2. stateSlotShapeSchema fixtures — valid / invalid / worst-plausible via AJV.
 *
 * Wiki: contracts/Extension-State.md + core/Session-Manifest.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import { stateSlotShapeSchema, verifyStateSlot } from "../../src/contracts/extension-state.js";

import type { StateSlotShape } from "../../src/contracts/extension-state.js";

// ---------------------------------------------------------------------------
// Helper: minimal valid shape
// ---------------------------------------------------------------------------

function makeShape(overrides: Partial<StateSlotShape> = {}): StateSlotShape {
  return {
    extId: "test-ext",
    slotVersion: "1.0.0",
    schema: { type: "object" },
    driftPolicy: "reject",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. verifyStateSlot — version match
// ---------------------------------------------------------------------------

describe("verifyStateSlot — version match", () => {
  it("accepts a stored slot matching the current slotVersion", async () => {
    const shape = makeShape({ slotVersion: "1.0.0", driftPolicy: "reject" });
    const result = await verifyStateSlot(shape, {
      slotVersion: "1.0.0",
      payload: { ok: true },
    });
    assert.equal(result.ok, true);
  });

  it("delivers the stored payload unchanged on version match", async () => {
    const payload = { step: 3, state: "running" };
    const shape = makeShape({ slotVersion: "2.1.0", driftPolicy: "reject" });
    const result = await verifyStateSlot(shape, { slotVersion: "2.1.0", payload });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.payload : null, payload);
  });
});

// ---------------------------------------------------------------------------
// 2. verifyStateSlot — unversioned slot
// ---------------------------------------------------------------------------

describe("verifyStateSlot — unversioned slot", () => {
  it("returns SlotVersionMissing for an unversioned slot", async () => {
    const shape = makeShape({ slotVersion: "1.0.0", driftPolicy: "reject" });
    const result = await verifyStateSlot(shape, { payload: { ok: true } });
    assert.equal(result.ok, false);
    const failure = result as {
      ok: false;
      error: { class: string; context: Record<string, unknown> };
    };
    assert.equal(failure.error.class, "Validation");
    assert.equal(failure.error.context["code"], "SlotVersionMissing");
  });

  it("SlotVersionMissing error carries extId in context", async () => {
    const shape = makeShape({ extId: "my-ext", driftPolicy: "reject" });
    const result = await verifyStateSlot(shape, { payload: {} });
    assert.equal(result.ok, false);
    const failure = result as { ok: false; error: { context: Record<string, unknown> } };
    assert.equal(failure.error.context["extId"], "my-ext");
  });
});

// ---------------------------------------------------------------------------
// 3. verifyStateSlot — reject policy on drift
// ---------------------------------------------------------------------------

describe("verifyStateSlot — reject policy on version drift", () => {
  it("returns SlotDriftRejected when version differs under reject policy", async () => {
    const shape = makeShape({ slotVersion: "2.0.0", driftPolicy: "reject" });
    const result = await verifyStateSlot(shape, {
      slotVersion: "1.0.0",
      payload: { ok: true },
    });
    assert.equal(result.ok, false);
    const failure = result as {
      ok: false;
      error: { class: string; context: Record<string, unknown> };
    };
    assert.equal(failure.error.class, "Session");
    assert.equal(failure.error.context["code"], "SlotDriftRejected");
  });

  it("SlotDriftRejected error carries extId, storedVersion, and expectedVersion", async () => {
    const shape = makeShape({ extId: "sm-ext", slotVersion: "2.0.0", driftPolicy: "reject" });
    const result = await verifyStateSlot(shape, { slotVersion: "1.0.0", payload: {} });
    assert.equal(result.ok, false);
    const failure = result as { ok: false; error: { context: Record<string, unknown> } };
    assert.equal(failure.error.context["extId"], "sm-ext");
    assert.equal(failure.error.context["storedVersion"], "1.0.0");
    assert.equal(failure.error.context["expectedVersion"], "2.0.0");
  });
});

// ---------------------------------------------------------------------------
// 4. verifyStateSlot — warn policy on drift
// ---------------------------------------------------------------------------

describe("verifyStateSlot — warn policy on version drift", () => {
  it("delivers the stored payload under warn policy when versions differ", async () => {
    const shape = makeShape({ slotVersion: "2.0.0", driftPolicy: "warn" });
    const result = await verifyStateSlot(shape, {
      slotVersion: "1.0.0",
      payload: { step: 7 },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.payload : null, { step: 7 });
  });
});

// ---------------------------------------------------------------------------
// 5. verifyStateSlot — migrate policy on drift
// ---------------------------------------------------------------------------

describe("verifyStateSlot — migrate policy on version drift", () => {
  it("runs the migrator and returns the migrated payload", async () => {
    const shape = makeShape({
      slotVersion: "2.0.0",
      driftPolicy: "migrate",
      migrate: (stored: unknown) => Promise.resolve({ migrated: true, original: stored }),
    });
    const result = await verifyStateSlot(shape, {
      slotVersion: "1.0.0",
      payload: { ok: true },
    });
    assert.equal(result.ok, true);
    const verdict = result as { ok: true; payload: { migrated: boolean } };
    assert.equal(verdict.payload.migrated, true);
  });

  it("migrator receives the stored payload and stored version", async () => {
    const captured: { payload: unknown; version: string }[] = [];
    const shape = makeShape({
      slotVersion: "3.0.0",
      driftPolicy: "migrate",
      migrate: (stored: unknown, storedVersion: string) => {
        captured.push({ payload: stored, version: storedVersion });
        return Promise.resolve({ upgraded: true });
      },
    });
    await verifyStateSlot(shape, { slotVersion: "2.0.0", payload: { x: 1 } });
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.version, "2.0.0");
    assert.deepEqual(captured[0]!.payload, { x: 1 });
  });

  it("returns SlotMigrationFailed when the migrator throws", async () => {
    const shape = makeShape({
      slotVersion: "2.0.0",
      driftPolicy: "migrate",
      migrate: () => Promise.reject(new Error("migration exploded")),
    });
    const result = await verifyStateSlot(shape, {
      slotVersion: "1.0.0",
      payload: { ok: true },
    });
    assert.equal(result.ok, false);
    const failure = result as {
      ok: false;
      error: { class: string; context: Record<string, unknown> };
    };
    assert.equal(failure.error.class, "Session");
    assert.equal(failure.error.context["code"], "SlotMigrationFailed");
  });

  it("SlotMigrationFailed preserves the original error as cause", async () => {
    const originalErr = new Error("root cause");
    const shape = makeShape({
      slotVersion: "2.0.0",
      driftPolicy: "migrate",
      migrate: () => Promise.reject(originalErr),
    });
    const result = await verifyStateSlot(shape, { slotVersion: "1.0.0", payload: {} });
    assert.equal(result.ok, false);
    const failure = result as { ok: false; error: { cause: unknown } };
    assert.equal(failure.error.cause, originalErr);
  });
});

// ---------------------------------------------------------------------------
// 6. stateSlotShapeSchema fixtures
// ---------------------------------------------------------------------------

describe("stateSlotShapeSchema", () => {
  // AJV v6: strip $schema before compiling.
  const { $schema: _ignored, ...compilableSchema } = stateSlotShapeSchema as Record<
    string,
    unknown
  >;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableSchema);

  it("accepts a valid shape", () => {
    const result = validate({
      extId: "a",
      slotVersion: "1.0.0",
      schema: { type: "object" },
      driftPolicy: "reject",
    });
    assert.equal(
      result,
      true,
      `Expected valid fixture to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("accepts all three valid driftPolicy values", () => {
    for (const policy of ["migrate", "warn", "reject"] as const) {
      const result = validate({
        extId: "a",
        slotVersion: "1.0.0",
        schema: { type: "object" },
        driftPolicy: policy,
      });
      assert.equal(
        result,
        true,
        `Expected driftPolicy '${policy}' to be accepted; errors: ${JSON.stringify(validate.errors)}`,
      );
    }
  });

  it("rejects an unknown driftPolicy with a path at /driftPolicy", () => {
    const result = validate({
      extId: "a",
      slotVersion: "1.0.0",
      schema: { type: "object" },
      driftPolicy: "bogus",
    });
    assert.equal(result, false, "Expected unknown driftPolicy to be rejected");
    const errors = validate.errors ?? [];
    const pathError = errors.find(
      (e) =>
        String((e as { dataPath?: string; instancePath?: string }).dataPath ?? "").includes(
          "driftPolicy",
        ) ||
        String((e as { dataPath?: string; instancePath?: string }).instancePath ?? "").includes(
          "driftPolicy",
        ),
    );
    assert.ok(
      pathError != null,
      `Expected an error at /driftPolicy; got ${JSON.stringify(errors)}`,
    );
  });

  it("rejects a non-SemVer slotVersion", () => {
    const result = validate({
      extId: "a",
      slotVersion: "not-semver",
      schema: { type: "object" },
      driftPolicy: "reject",
    });
    assert.equal(result, false, "Expected non-SemVer slotVersion to be rejected");
  });

  it("rejects a shape missing required field extId", () => {
    const result = validate({
      slotVersion: "1.0.0",
      schema: { type: "object" },
      driftPolicy: "reject",
    });
    assert.equal(result, false, "Expected missing extId to be rejected");
  });

  it("rejects worst-plausible input without AJV throwing", () => {
    let rejected: boolean;
    try {
      rejected = !validate({
        extId: "a",
        slotVersion: "1.0.0",
        schema: { type: "object" },
        driftPolicy: "reject",
        extra: "x".repeat(1_000_000),
      });
    } catch (err) {
      return assert.fail(`AJV threw on worst-plausible input: ${String(err)}`);
    }
    assert.ok(rejected, "Expected worst-plausible fixture to be rejected");
  });
});
