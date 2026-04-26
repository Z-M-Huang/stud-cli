/**
 * UAT-32 + AC-81: Session-Resume-Drift — core resume never fails on
 * extension drift; cross-store resume IS a critical mismatch.
 *
 * Per Q-2 the session manifest stores ONLY:
 *   - messages
 *   - attached-SM state (smExtId + slot reference)
 *   - mode
 *   - projectRoot
 *
 * It does NOT store the extension set, config hashes, or capability
 * probes. So extension drift between launches is invisible to the
 * manifest layer — and that is precisely the property we verify:
 *
 *   1. Removing a previously-configured logger between launches has no
 *      effect on the manifest's resume path; the same manifest reads
 *      back identically.
 *   2. A manifest with an `smState.smExtId` that no longer matches a
 *      loaded SM extension still resumes — the slot is simply unread.
 *   3. A manifest written by Store A and resumed by Store B throws
 *      `Session/ResumeMismatch` (the only piece of identity the manifest
 *      DOES track is `writtenByStore`).
 *
 * Wiki: flows/Session-Resume-Drift.md + contracts/Session-Store.md
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { contract as filesystemStore } from "../../src/extensions/session-stores/filesystem/index.js";
import { mockHost } from "../helpers/mock-host.js";

import type { SessionManifest } from "../../src/contracts/session-store.js";

let projectRoot: string;

before(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "drift-"));
  await mkdir(join(projectRoot, "sessions"), { recursive: true });
});

after(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

function createHost(root: string) {
  const handle = mockHost({ extId: "filesystem" });
  const session = { ...handle.host.session, projectRoot: root };
  return Object.freeze({ ...handle.host, session }) as unknown as typeof handle.host;
}

async function persistAndDispose(manifest: SessionManifest, root: string) {
  const host = createHost(root);
  await filesystemStore.lifecycle.init?.(host, { rootDir: root });
  await filesystemStore.lifecycle.activate?.(host);
  const result = await filesystemStore.write(manifest, [], host);
  await filesystemStore.lifecycle.deactivate?.(host);
  await filesystemStore.lifecycle.dispose?.(host);
  if (!result.ok) throw new Error(`persist failed: ${result.error.message}`);
}

async function readBack(sessionId: string, root: string) {
  const host = createHost(root);
  await filesystemStore.lifecycle.init?.(host, { rootDir: root });
  await filesystemStore.lifecycle.activate?.(host);
  const result = await filesystemStore.read(sessionId, host);
  await filesystemStore.lifecycle.deactivate?.(host);
  await filesystemStore.lifecycle.dispose?.(host);
  return result;
}

describe("UAT-32: Session-Resume-Drift", () => {
  it("removed optional logger between launches: resume succeeds (manifest is logger-agnostic)", async () => {
    const sessionId = "drift-no-logger";
    const manifest: SessionManifest = {
      sessionId,
      projectRoot,
      mode: "ask",
      storeId: filesystemStore.storeId,
      createdAt: 1,
      updatedAt: 1,
      messages: [{ id: "m1", role: "user", content: "hello", monotonicTs: "1" }],
    };
    await persistAndDispose(manifest, projectRoot);
    // Simulate "extension config changed between launches" — but the
    // manifest itself doesn't reference loggers, so the read is
    // independent of any logger-config drift.
    const result = await readBack(sessionId, projectRoot);
    assert.equal(result.ok, true, "resume must succeed regardless of logger drift");
    if (result.ok) {
      assert.equal(result.manifest.sessionId, sessionId);
      assert.equal(result.manifest.messages.length, 1);
    }
  });

  it("manifest with smExtId for a no-longer-loaded SM still resumes", async () => {
    const sessionId = "drift-missing-sm";
    const manifest: SessionManifest = {
      sessionId,
      projectRoot,
      mode: "ask",
      storeId: filesystemStore.storeId,
      createdAt: 1,
      updatedAt: 1,
      messages: [
        { id: "m1", role: "user", content: "before", monotonicTs: "1" },
        { id: "m2", role: "assistant", content: "after", monotonicTs: "2" },
      ],
      smState: {
        smExtId: "nonexistent-sm-ext",
        stateSlotRef: '{"current":"some-stage"}',
      },
    };
    await persistAndDispose(manifest, projectRoot);
    const result = await readBack(sessionId, projectRoot);
    assert.equal(result.ok, true, "resume must succeed even when smExtId no longer matches");
    if (result.ok) {
      // The smState round-trips — it is up to the orchestrator to ignore it
      // when the SM is no longer loaded.
      assert.equal(result.manifest.smState?.smExtId, "nonexistent-sm-ext");
      assert.equal(result.manifest.messages.length, 2);
    }
  });

  it("cross-store resume throws Session/ResumeMismatch", async () => {
    const sessionId = "drift-cross-store";
    // Persist a valid manifest first.
    const manifest: SessionManifest = {
      sessionId,
      projectRoot,
      mode: "ask",
      storeId: filesystemStore.storeId,
      createdAt: 1,
      updatedAt: 1,
      messages: [{ id: "m1", role: "user", content: "x", monotonicTs: "1" }],
    };
    await persistAndDispose(manifest, projectRoot);

    // Tamper with the persisted manifest's writtenByStore field to
    // simulate a manifest that came from a different store.
    const sessionsDir = join(projectRoot, "sessions");
    const filePath = join(sessionsDir, `${sessionId}.json`);
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed["writtenByStore"] = "some-other-store";
    await writeFile(filePath, JSON.stringify(parsed));

    const result = await readBack(sessionId, projectRoot);
    assert.equal(result.ok, false, "cross-store resume must fail");
    if (!result.ok) {
      assert.equal(result.error.class, "Session");
      assert.equal(result.error.context["code"], "ResumeMismatch");
    }
  });

  it("missing manifest file throws a typed Session error (not a generic crash)", async () => {
    const result = await readBack("definitely-not-a-real-session-id-12345", projectRoot);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "Session");
    }
  });
});
