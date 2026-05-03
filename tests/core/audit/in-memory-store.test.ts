import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAuditRecordStore } from "../../../src/core/audit/in-memory-store.js";

describe("createAuditRecordStore — append and query", () => {
  it("appends and queries records by class", () => {
    const store = createAuditRecordStore();
    store.append({
      class: "SubagentExecution",
      kind: "SubagentSpawned",
      correlationId: "c1",
      timestamp: 100,
      payload: { subagentId: "s1", parentSessionId: "p1", depth: 1 },
      subagentId: "s1",
      parentSessionId: "p1",
      depth: 1,
    });
    store.append({
      class: "Approval",
      kind: "ToolCallApproved",
      correlationId: "c2",
      timestamp: 110,
      payload: { toolId: "read" },
    });

    const all = store.query();
    assert.equal(all.length, 2);

    const subagentOnly = store.query({ class: "SubagentExecution" });
    assert.equal(subagentOnly.length, 1);
    assert.equal(subagentOnly[0]!.kind, "SubagentSpawned");

    const byCorrelation = store.query({ correlationId: "c2" });
    assert.equal(byCorrelation.length, 1);
    assert.equal(byCorrelation[0]!.kind, "ToolCallApproved");
  });

  it("filters by subagentId", () => {
    const store = createAuditRecordStore();
    store.append({
      class: "SubagentExecution",
      kind: "SubagentSpawned",
      correlationId: "c1",
      timestamp: 100,
      payload: { subagentId: "s1" },
      subagentId: "s1",
      parentSessionId: "p1",
      depth: 1,
    });
    store.append({
      class: "SubagentExecution",
      kind: "SubagentSpawned",
      correlationId: "c2",
      timestamp: 110,
      payload: { subagentId: "s2" },
      subagentId: "s2",
      parentSessionId: "p1",
      depth: 1,
    });

    const justS1 = store.query({ subagentId: "s1" });
    assert.equal(justS1.length, 1);
  });

  it("query result is decoupled from the store after return", () => {
    const store = createAuditRecordStore();
    store.append({
      class: "Approval",
      kind: "ToolCallApproved",
      correlationId: "c1",
      timestamp: 100,
      payload: {},
    });
    const snapshot = store.query();
    store.append({
      class: "Approval",
      kind: "ToolCallApproved",
      correlationId: "c2",
      timestamp: 110,
      payload: {},
    });
    assert.equal(snapshot.length, 1);
    assert.equal(store.query().length, 2);
  });
});

describe("createAuditRecordStore — activeSubagents projection", () => {
  it("returns spawned subagents that have no terminal record", () => {
    const store = createAuditRecordStore();

    // Two spawns, one Completed.
    store.append({
      class: "SubagentExecution",
      kind: "SubagentSpawned",
      correlationId: "c1",
      timestamp: 100,
      payload: {
        subagentId: "s1",
        parentSessionId: "p1",
        depth: 1,
        approvedEnvelope: ["read"],
        providerId: "anthropic",
        modelId: "sonnet",
      },
      subagentId: "s1",
      parentSessionId: "p1",
      depth: 1,
    });
    store.append({
      class: "SubagentExecution",
      kind: "SubagentSpawned",
      correlationId: "c2",
      timestamp: 110,
      payload: {
        subagentId: "s2",
        parentSessionId: "p1",
        depth: 1,
        approvedEnvelope: ["http-request"],
        providerId: "anthropic",
        modelId: "haiku",
      },
      subagentId: "s2",
      parentSessionId: "p1",
      depth: 1,
    });
    store.append({
      class: "SubagentExecution",
      kind: "SubagentCompleted",
      correlationId: "c1",
      timestamp: 200,
      payload: { subagentId: "s1" },
      subagentId: "s1",
      parentSessionId: "p1",
      depth: 1,
    });

    const active = store.activeSubagents();
    assert.equal(active.length, 1);
    assert.equal(active[0]!.subagentId, "s2");
    assert.deepEqual(active[0]!.approvedEnvelope, ["http-request"]);
    assert.equal(active[0]!.providerId, "anthropic");
    assert.equal(active[0]!.modelId, "haiku");
  });

  it("excludes Halted and Aborted as terminal", () => {
    const store = createAuditRecordStore();
    for (const id of ["s1", "s2", "s3"]) {
      store.append({
        class: "SubagentExecution",
        kind: "SubagentSpawned",
        correlationId: id,
        timestamp: 100,
        payload: { subagentId: id, approvedEnvelope: [], providerId: "p", modelId: "m" },
        subagentId: id,
        parentSessionId: "p1",
        depth: 1,
      });
    }
    store.append({
      class: "SubagentExecution",
      kind: "SubagentHalted",
      correlationId: "s2",
      timestamp: 110,
      payload: { subagentId: "s2" },
      subagentId: "s2",
      parentSessionId: "p1",
      depth: 1,
    });
    store.append({
      class: "SubagentExecution",
      kind: "SubagentAborted",
      correlationId: "s3",
      timestamp: 110,
      payload: { subagentId: "s3" },
      subagentId: "s3",
      parentSessionId: "p1",
      depth: 1,
    });

    const active = store.activeSubagents();
    assert.equal(active.length, 1);
    assert.equal(active[0]!.subagentId, "s1");
  });
});
