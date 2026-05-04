import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  emitSubagentResumeScan,
  findDanglingSpawns,
} from "../../../src/core/subagent/resume-scan.js";

import type { SessionAuditBus } from "../../../src/cli/runtime/audit-bus.js";

function jsonl(records: readonly Record<string, unknown>[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

describe("findDanglingSpawns", () => {
  it("returns empty for an empty log", () => {
    assert.deepEqual(findDanglingSpawns(""), []);
  });

  it("returns empty when every spawn has a matching terminal record", () => {
    const log = jsonl([
      {
        type: "SubagentSpawned",
        payload: { subagentId: "s1", parentSessionId: "p1", depth: 1 },
      },
      {
        type: "SubagentCompleted",
        payload: { subagentId: "s1" },
      },
    ]);
    assert.deepEqual(findDanglingSpawns(log), []);
  });

  it("returns the unterminated spawn", () => {
    const log = jsonl([
      {
        type: "SubagentSpawned",
        payload: { subagentId: "s1", parentSessionId: "p1", depth: 1 },
      },
      {
        type: "SubagentSpawned",
        payload: { subagentId: "s2", parentSessionId: "p1", depth: 1 },
      },
      {
        type: "SubagentCompleted",
        payload: { subagentId: "s1" },
      },
    ]);
    const dangling = findDanglingSpawns(log);
    assert.equal(dangling.length, 1);
    assert.equal(dangling[0]!.subagentId, "s2");
    assert.equal(dangling[0]!.parentSessionId, "p1");
    assert.equal(dangling[0]!.depth, 1);
  });

  it("treats Halted and Aborted as terminal", () => {
    const log = jsonl([
      { type: "SubagentSpawned", payload: { subagentId: "s1" } },
      { type: "SubagentHalted", payload: { subagentId: "s1" } },
      { type: "SubagentSpawned", payload: { subagentId: "s2" } },
      { type: "SubagentAborted", payload: { subagentId: "s2" } },
    ]);
    assert.deepEqual(findDanglingSpawns(log), []);
  });

  it("tolerates malformed lines and continues parsing", () => {
    const log = [
      JSON.stringify({ type: "SubagentSpawned", payload: { subagentId: "s1" } }),
      "this is not json",
      "",
      JSON.stringify({ type: "SubagentSpawned", payload: { subagentId: "s2" } }),
      JSON.stringify({ type: "SubagentCompleted", payload: { subagentId: "s2" } }),
    ].join("\n");
    const dangling = findDanglingSpawns(log);
    assert.equal(dangling.length, 1);
    assert.equal(dangling[0]!.subagentId, "s1");
  });

  it("ignores records with non-string subagentId", () => {
    const log = jsonl([{ type: "SubagentSpawned", payload: { subagentId: 42 } }]);
    assert.deepEqual(findDanglingSpawns(log), []);
  });

  it("ignores records with non-string kind or non-object payload", () => {
    const log = jsonl([
      { type: 42, payload: { subagentId: "s1" } },
      { type: "SubagentSpawned", payload: null },
      { type: "SubagentSpawned", payload: "bad" },
      { type: "SubagentSpawned", payload: { subagentId: "s2", parentSessionId: 12, depth: "x" } },
    ]);
    assert.deepEqual(findDanglingSpawns(log), [
      { subagentId: "s2", parentSessionId: "", depth: 1 },
    ]);
  });
});

describe("emitSubagentResumeScan", () => {
  it("emits synthetic SubagentAborted records for dangling spawns", async () => {
    const globalRoot = await mkdtemp(join(tmpdir(), "resume-scan-"));
    try {
      const priorSessionId = "prior-session";
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- mkdtemp-scoped fixture path
      await mkdir(join(globalRoot, "logs"), { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- mkdtemp-scoped fixture path
      await writeFile(
        join(globalRoot, "logs", `session-${priorSessionId}.jsonl`),
        jsonl([
          {
            type: "SubagentSpawned",
            payload: { subagentId: "s1", parentSessionId: "p1", depth: 2 },
          },
          {
            type: "SubagentCompleted",
            payload: { subagentId: "s2" },
          },
        ]),
        { encoding: "utf8" },
      );
      const emitted: { kind: string; payload: Record<string, unknown> }[] = [];
      await emitSubagentResumeScan({
        auditBus: {
          emit(kind: string, payload: Readonly<Record<string, unknown>>) {
            emitted.push({ kind, payload: { ...payload } });
          },
        } as unknown as SessionAuditBus,
        globalRoot,
        priorSessionId,
      });

      assert.deepEqual(emitted, [
        {
          kind: "SubagentAborted",
          payload: {
            kind: "SubagentAborted",
            parentSessionId: "p1",
            subagentId: "s1",
            depth: 2,
            reason: "crash",
          },
        },
      ]);
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
    }
  });

  it("swallows missing prior-session logs", async () => {
    const globalRoot = await mkdtemp(join(tmpdir(), "resume-scan-missing-"));
    try {
      let emitted = 0;
      await emitSubagentResumeScan({
        auditBus: {
          emit() {
            emitted += 1;
          },
        } as unknown as SessionAuditBus,
        globalRoot,
        priorSessionId: "missing",
      });
      assert.equal(emitted, 0);
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
    }
  });
});
