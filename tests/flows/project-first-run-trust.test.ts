/**
 *  companion +  (acceptance branch): Project-First-Run-Trust
 * acceptance flow.
 *
 * Drives the project-trust gate twice against a shared in-memory trust
 * store, with the first launch accepting the prompt and the second
 * launch carrying a "would-refuse" interactor that the gate must NOT
 * call (the persisted grant short-circuits the prompt).
 *
 * Asserts:
 *   1. First launch persists the canonical project path in the trust list.
 *   2. The trust list keys by the absolute, canonical (resolved) path.
 *   3. The second launch does NOT prompt again.
 *   4. Both launches emit a TrustDecision audit record with
 *      decision=granted (per the gate's "audit every evaluation" rule).
 *
 * Companion to tests/flows/first-run.test.ts which covers the refusal
 * branch.
 *
 * Wiki: flows/Project-First-Run-Trust.md + security/Project-Trust.md
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import { runAcceptanceThenResume } from "./_helpers/first-run-harness.js";

let projectRoot: string;

before(async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "trust-accept-"));
  projectRoot = join(baseDir, ".stud");
  await mkdir(projectRoot, { recursive: true });
});

after(async () => {
  await rm(join(projectRoot, ".."), { recursive: true, force: true });
});

describe(" companion: Project-First-Run-Trust acceptance path", () => {
  it("first launch persists the canonical project path in the trust list", async () => {
    const run = await runAcceptanceThenResume({ projectRoot });
    assert.equal(run.firstLaunch.outcome.kind, "granted");
    assert.equal(run.trustListAfter.includes(projectRoot), true);
  });

  it("trust list is keyed by the absolute (resolved) path", async () => {
    const run = await runAcceptanceThenResume({ projectRoot });
    for (const entry of run.trustListAfter) {
      assert.equal(entry, resolve(entry), `entry must be canonical: ${entry}`);
    }
  });

  it("second launch in the same project does NOT prompt again", async () => {
    const run = await runAcceptanceThenResume({ projectRoot });
    assert.equal(run.secondLaunchPromptedAgain, false);
    assert.equal(run.secondLaunch.confirmCalls, 0);
  });

  it("second launch returns 'granted' from the persisted entry", async () => {
    const run = await runAcceptanceThenResume({ projectRoot });
    assert.equal(run.secondLaunch.outcome.kind, "granted");
  });

  it("both launches emit a TrustDecision audit record with decision=granted", async () => {
    const run = await runAcceptanceThenResume({ projectRoot });
    assert.equal(run.firstLaunch.auditRecords.length, 1);
    assert.equal(run.firstLaunch.auditRecords[0]?.decision, "granted");
    assert.equal(run.secondLaunch.auditRecords.length, 1);
    assert.equal(run.secondLaunch.auditRecords[0]?.decision, "granted");
  });

  it("trust list size remains exactly one across both launches (no duplicates)", async () => {
    const run = await runAcceptanceThenResume({ projectRoot });
    assert.equal(run.trustListAfter.length, 1);
  });
});
