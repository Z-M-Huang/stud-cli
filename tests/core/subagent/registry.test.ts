import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSubagentRecord,
  createSessionSubagentRegistry,
} from "../../../src/core/subagent/registry.js";

describe("SessionSubagentRegistry", () => {
  it("starts empty", () => {
    const registry = createSessionSubagentRegistry();
    assert.equal(registry.size(), 0);
    assert.deepEqual(registry.list(), []);
  });

  it("spawns and lists in insertion order", () => {
    const registry = createSessionSubagentRegistry();
    registry.spawn(
      buildSubagentRecord({
        subagentId: "a",
        parentSessionId: "p",
        depth: 1,
        model: { providerId: "anthropic", modelId: "x" },
        approvedEnvelope: [],
        spawnedAt: 100,
      }),
    );
    registry.spawn(
      buildSubagentRecord({
        subagentId: "b",
        parentSessionId: "p",
        depth: 1,
        model: { providerId: "anthropic", modelId: "x" },
        approvedEnvelope: [],
        spawnedAt: 200,
      }),
    );
    const ids = registry.list().map((r) => r.subagentId);
    assert.deepEqual(ids, ["a", "b"]);
    assert.equal(registry.size(), 2);
  });

  it("transition updates state without changing identity", () => {
    const registry = createSessionSubagentRegistry();
    registry.spawn(
      buildSubagentRecord({
        subagentId: "a",
        parentSessionId: "p",
        depth: 1,
        model: { providerId: "anthropic", modelId: "x" },
        approvedEnvelope: ["read"],
        spawnedAt: 1,
      }),
    );
    registry.transition("a", "Running");
    const record = registry.get("a");
    assert.equal(record?.state, "Running");
    assert.equal(record?.subagentId, "a");
  });

  it("terminate removes the record", () => {
    const registry = createSessionSubagentRegistry();
    registry.spawn(
      buildSubagentRecord({
        subagentId: "a",
        parentSessionId: "p",
        depth: 1,
        model: { providerId: "anthropic", modelId: "x" },
        approvedEnvelope: [],
        spawnedAt: 1,
      }),
    );
    registry.terminate("a");
    assert.equal(registry.get("a"), undefined);
    assert.equal(registry.size(), 0);
  });

  it("buildSubagentRecord defaults state to Requested and omits label when absent", () => {
    const record = buildSubagentRecord({
      subagentId: "x",
      parentSessionId: "p",
      depth: 2,
      model: { providerId: "anthropic", modelId: "m" },
      approvedEnvelope: ["edit"],
      spawnedAt: 42,
    });
    assert.equal(record.state, "Requested");
    assert.equal(record.label, undefined);
  });
});
