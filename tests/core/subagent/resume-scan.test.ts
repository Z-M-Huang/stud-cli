import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findDanglingSpawns } from "../../../src/core/subagent/resume-scan.js";

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
});
