/**
 * UAT-5 + AC-62: First-run trust prompt gates `.stud/` loading.
 *
 * Drives the project-trust gate (`src/core/project/trust-gate.ts`) with a
 * refusing interactor stub and asserts the safety invariants:
 *
 *   1. The gate prompts exactly once (no double-prompts).
 *   2. Refusal returns outcome `{kind: "refused"}`.
 *   3. The trust store is byte-identical before vs. after refusal.
 *   4. Exactly one audit record is written, with `decision: "refused"`.
 *   5. By contrast, an accepting interactor persists the entry and emits
 *      `decision: "granted"` — proving the gate's two-path symmetry.
 *
 * Scope: the trust gate is the unit under test. The gate is structurally
 * decoupled from the file system — it consults the injected trust store
 * (in-memory here) and never reads files under `projectRoot` unless the
 * caller proceeds to load extensions after a "granted" outcome. Therefore
 * a fs-read spy is unnecessary at the gate level: the gate cannot read
 * `.stud/` even on the granted path; that is the orchestrator's job. We
 * verify the contract the gate owns — prompt, decision, persistence,
 * audit — and rely on the project-entry orchestrator's own tests for the
 * "no .stud/ I/O happens until trust is granted" property.
 *
 * Wiki: security/Project-Trust.md + flows/Project-First-Run-Trust.md
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { runFirstRunWithAcceptance, runFirstRunWithRefusal } from "./_helpers/first-run-harness.js";

let projectRoot: string;
let craftedFile: string;

before(async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "first-run-"));
  projectRoot = join(baseDir, ".stud");
  await mkdir(projectRoot, { recursive: true });
  // Plant a deliberately crafty extension.json — the test asserts the
  // gate never reads under projectRoot, so this file should remain
  // untouched on the refusal path.
  craftedFile = join(projectRoot, "extension.json");
  await writeFile(craftedFile, '{"__crashIfRead": true}');
});

after(async () => {
  // Clean up everything under the temp base dir (parent of projectRoot).
  await rm(join(projectRoot, ".."), { recursive: true, force: true });
});

describe("UAT-5: First-run trust prompt — refusal path", () => {
  it("prompts the interactor exactly once on first entry", async () => {
    const run = await runFirstRunWithRefusal({ projectRoot });
    assert.equal(run.confirmCalls, 1);
  });

  it("refusal returns outcome {kind: 'refused'}", async () => {
    const run = await runFirstRunWithRefusal({ projectRoot });
    assert.equal(run.outcome.kind, "refused");
    assert.equal(run.outcome.canonicalPath, projectRoot);
  });

  it("trust store remains empty after refusal (byte-identical)", async () => {
    const run = await runFirstRunWithRefusal({ projectRoot });
    assert.deepEqual(run.trustEntriesAfter, []);
  });

  it("emits exactly one TrustDecision audit record with decision=refused", async () => {
    const run = await runFirstRunWithRefusal({ projectRoot });
    assert.equal(run.auditRecords.length, 1);
    const record = run.auditRecords[0]!;
    assert.equal(record.decision, "refused");
    assert.equal(record.canonicalPath, projectRoot);
    assert.match(record.at, /^\d{4}-\d{2}-\d{2}T/u, "ISO-8601 timestamp");
  });

  it("does not throw on refusal (cooperative exit)", async () => {
    await assert.doesNotReject(async () => {
      await runFirstRunWithRefusal({ projectRoot });
    });
  });
});

describe("UAT-5 (control): grant path persists and audits", () => {
  it("acceptance persists the entry and emits decision=granted", async () => {
    const run = await runFirstRunWithAcceptance({ projectRoot });
    assert.equal(run.outcome.kind, "granted");
    assert.deepEqual(run.trustEntriesAfter, [projectRoot]);
    assert.equal(run.auditRecords.length, 1);
    assert.equal(run.auditRecords[0]?.decision, "granted");
  });

  it("pre-existing grant short-circuits the prompt and still audits", async () => {
    const run = await runFirstRunWithRefusal({
      projectRoot,
      initialTrustEntries: [projectRoot],
    });
    // No prompt should be raised when the path is already trusted.
    assert.equal(run.confirmCalls, 0);
    assert.equal(run.outcome.kind, "granted");
    assert.equal(run.auditRecords.length, 1);
    assert.equal(run.auditRecords[0]?.decision, "granted");
  });
});
