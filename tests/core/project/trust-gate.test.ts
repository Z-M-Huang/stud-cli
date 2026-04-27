/**
 * Unit tests for `evaluateProjectTrust`.
 *
 * Before any `.stud/` file is read or executed, the trust gate must
 *   run. Refusal leaves `.stud/` untouched; acceptance records the grant.
 * Every gate run emits a `TrustDecision` audit record.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Cancellation } from "../../../src/core/errors/cancellation.js";
import { evaluateProjectTrust } from "../../../src/core/project/trust-gate.js";
import {
  failingTrustStore,
  mockAudit,
  mockInteractor,
  mockTrustStore,
} from "../../helpers/trust-fixtures.js";

const CANONICAL = "/canonical/proj/.stud";

// ---------------------------------------------------------------------------
// Refusal path
// ---------------------------------------------------------------------------

describe("evaluateProjectTrust — refusal path", () => {
  it("refuses → .stud/ is never opened and no trust entry is written", async () => {
    const store = mockTrustStore({ entries: [] });
    const audit = mockAudit();

    const result = await evaluateProjectTrust({
      projectRoot: CANONICAL,
      interactor: mockInteractor({ confirm: false }),
      trustStore: store,
      audit,
    });

    assert.equal(result.kind, "refused");
    assert.equal(result.canonicalPath, CANONICAL);
    // Trust store was not mutated ( — no .stud/ content accessed on refusal)
    assert.deepEqual([...store.listEntries()], []);
  });

  it("refused outcome emits one TrustDecision audit record", async () => {
    const audit = mockAudit();

    await evaluateProjectTrust({
      projectRoot: CANONICAL,
      interactor: mockInteractor({ confirm: false }),
      trustStore: mockTrustStore({ entries: [] }),
      audit,
    });

    assert.deepEqual(
      audit.records.map((r) => r.decision),
      ["refused"],
    );
    assert.equal(audit.records[0]?.canonicalPath, CANONICAL);
    assert.ok(typeof audit.records[0]?.at === "string", "audit record must carry a timestamp");
  });

  it("refused outcome carries no grantedAt timestamp", async () => {
    const result = await evaluateProjectTrust({
      projectRoot: CANONICAL,
      interactor: mockInteractor({ confirm: false }),
      trustStore: mockTrustStore({ entries: [] }),
      audit: mockAudit(),
    });

    assert.equal(result.kind, "refused");
    assert.equal(result.grantedAt, undefined);
  });
});

// ---------------------------------------------------------------------------
// Grant path — first entry
// ---------------------------------------------------------------------------

describe("evaluateProjectTrust — grant path (first entry)", () => {
  it("grants on first entry → persists to trust list keyed by canonical path", async () => {
    const store = mockTrustStore({ entries: [] });
    const audit = mockAudit();

    const result = await evaluateProjectTrust({
      projectRoot: CANONICAL,
      interactor: mockInteractor({ confirm: true }),
      trustStore: store,
      audit,
    });

    assert.equal(result.kind, "granted");
    assert.equal(result.canonicalPath, CANONICAL);
    // Trust store now contains exactly this canonical path
    assert.deepEqual([...store.listEntries()], [CANONICAL]);
    // Exactly one audit record with decision "granted"
    assert.equal(audit.records.length, 1);
    assert.equal(audit.records[0]?.decision, "granted");
    assert.equal(audit.records[0]?.canonicalPath, CANONICAL);
  });

  it("granted outcome carries an ISO-8601 grantedAt timestamp", async () => {
    const result = await evaluateProjectTrust({
      projectRoot: CANONICAL,
      interactor: mockInteractor({ confirm: true }),
      trustStore: mockTrustStore({ entries: [] }),
      audit: mockAudit(),
    });

    assert.equal(result.kind, "granted");
    assert.ok(typeof result.grantedAt === "string", "grantedAt must be present on grant");
    assert.ok(
      typeof result.grantedAt === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(result.grantedAt),
      "grantedAt must be ISO-8601",
    );
  });
});

// ---------------------------------------------------------------------------
// Pre-existing grant short-circuit
// ---------------------------------------------------------------------------

describe("evaluateProjectTrust — pre-existing grant", () => {
  it("pre-existing grant short-circuits without prompting", async () => {
    const store = mockTrustStore({ entries: [CANONICAL] });
    const interactor = mockInteractor({ confirm: false });

    const result = await evaluateProjectTrust({
      projectRoot: CANONICAL,
      interactor,
      trustStore: store,
      audit: mockAudit(),
    });

    assert.equal(result.kind, "granted");
    // No prompt was raised
    assert.equal(interactor.promptsRaised, 0);
    // Trust store was not mutated (entry already present)
    assert.deepEqual([...store.listEntries()], [CANONICAL]);
  });

  it("pre-existing grant emits one TrustDecision audit record ( — each evaluation is audited)", async () => {
    const audit = mockAudit();

    await evaluateProjectTrust({
      projectRoot: CANONICAL,
      interactor: mockInteractor({ confirm: false }),
      trustStore: mockTrustStore({ entries: [CANONICAL] }),
      audit,
    });

    // every evaluation — including pre-existing grants — must produce an audit record
    assert.equal(audit.records.length, 1);
    assert.equal(audit.records[0]?.decision, "granted");
    assert.equal(audit.records[0]?.canonicalPath, CANONICAL);
    assert.ok(typeof audit.records[0]?.at === "string", "audit record must carry a timestamp");
  });
});

// ---------------------------------------------------------------------------
// Validation errors — Validation/ProjectPathInvalid
// ---------------------------------------------------------------------------

describe("evaluateProjectTrust — validation errors", () => {
  async function expectProjectPathInvalid(projectRoot: string): Promise<void> {
    let err: unknown;
    try {
      await evaluateProjectTrust({
        projectRoot,
        interactor: mockInteractor({ confirm: true }),
        trustStore: mockTrustStore({ entries: [] }),
        audit: mockAudit(),
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, "should have thrown");
    assert.equal((err as { class?: string }).class, "Validation");
    assert.equal((err as { context?: { code?: string } }).context?.code, "ProjectPathInvalid");
  }

  it("non-canonical projectRoot (contains ..) → Validation/ProjectPathInvalid", async () => {
    await expectProjectPathInvalid("/proj/../proj/.stud");
  });

  it("relative projectRoot → Validation/ProjectPathInvalid", async () => {
    await expectProjectPathInvalid("relative/path/.stud");
  });

  it("absolute path not ending in .stud → Validation/ProjectPathInvalid", async () => {
    await expectProjectPathInvalid("/canonical/proj");
  });

  it("validation error carries the invalid path in context for diagnostics", async () => {
    const badPath = "/proj/../proj/.stud";
    let err: unknown;
    try {
      await evaluateProjectTrust({
        projectRoot: badPath,
        interactor: mockInteractor({ confirm: true }),
        trustStore: mockTrustStore({ entries: [] }),
        audit: mockAudit(),
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, "should have thrown");
    assert.equal((err as { context?: { projectRoot?: string } }).context?.projectRoot, badPath);
  });
});

// ---------------------------------------------------------------------------
// Prompt-count invariant
// ---------------------------------------------------------------------------

describe("evaluateProjectTrust — prompt count invariant", () => {
  it("raises exactly one confirm prompt on a first-entry grant", async () => {
    const interactor = mockInteractor({ confirm: true });

    await evaluateProjectTrust({
      projectRoot: CANONICAL,
      interactor,
      trustStore: mockTrustStore({ entries: [] }),
      audit: mockAudit(),
    });

    assert.equal(interactor.promptsRaised, 1);
  });

  it("raises exactly one confirm prompt on a first-entry refusal", async () => {
    const interactor = mockInteractor({ confirm: false });

    await evaluateProjectTrust({
      projectRoot: CANONICAL,
      interactor,
      trustStore: mockTrustStore({ entries: [] }),
      audit: mockAudit(),
    });

    assert.equal(interactor.promptsRaised, 1);
  });
});

// ---------------------------------------------------------------------------
// Trust-store error paths — Session/TrustStoreUnavailable
// ---------------------------------------------------------------------------

describe("evaluateProjectTrust — trust-store error paths", () => {
  it("trustStore.isGranted throws → Session/TrustStoreUnavailable", async () => {
    let err: unknown;
    try {
      await evaluateProjectTrust({
        projectRoot: CANONICAL,
        interactor: mockInteractor({ confirm: true }),
        trustStore: failingTrustStore({ throwOn: "isGranted" }),
        audit: mockAudit(),
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, "should have thrown");
    assert.equal((err as { class?: string }).class, "Session");
    assert.equal((err as { context?: { code?: string } }).context?.code, "TrustStoreUnavailable");
  });

  it("trustStore.addEntry throws → Session/TrustStoreUnavailable", async () => {
    let err: unknown;
    try {
      await evaluateProjectTrust({
        projectRoot: CANONICAL,
        interactor: mockInteractor({ confirm: true }),
        trustStore: failingTrustStore({ throwOn: "addEntry" }),
        audit: mockAudit(),
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, "should have thrown");
    assert.equal((err as { class?: string }).class, "Session");
    assert.equal((err as { context?: { code?: string } }).context?.code, "TrustStoreUnavailable");
  });
});

// ---------------------------------------------------------------------------
// Cancellation propagation — Cancellation/TurnCancelled
// ---------------------------------------------------------------------------

describe("evaluateProjectTrust — cancellation propagation", () => {
  it("Cancellation/TurnCancelled thrown by interactor propagates to the caller unchanged", async () => {
    // Simulate a cancel signal arriving while the user is being prompted.
    // The gate must not swallow it or wrap it in a different error class.
    const cancel = new Cancellation("turn cancelled by user", undefined, {
      code: "TurnCancelled",
    });

    let err: unknown;
    try {
      await evaluateProjectTrust({
        projectRoot: CANONICAL,
        interactor: mockInteractor({ throws: cancel }),
        trustStore: mockTrustStore({ entries: [] }),
        audit: mockAudit(),
      });
    } catch (e) {
      err = e;
    }

    // Must be the exact same object — no re-wrapping
    assert.strictEqual(err, cancel, "cancellation must propagate as-is (same reference)");
    assert.equal((err as { class?: string }).class, "Cancellation");
    assert.equal((err as { context?: { code?: string } }).context?.code, "TurnCancelled");
  });

  it("Cancellation during prompt leaves trust store unmodified", async () => {
    const store = mockTrustStore({ entries: [] });
    const cancel = new Cancellation("turn cancelled", undefined, { code: "TurnCancelled" });

    try {
      await evaluateProjectTrust({
        projectRoot: CANONICAL,
        interactor: mockInteractor({ throws: cancel }),
        trustStore: store,
        audit: mockAudit(),
      });
    } catch {
      // expected — assert below
    }

    assert.deepEqual([...store.listEntries()], [], "trust store must not be mutated on cancel");
  });
});
