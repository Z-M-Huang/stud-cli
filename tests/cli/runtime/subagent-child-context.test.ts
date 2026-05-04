import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildChildSession } from "../../../src/cli/runtime/subagent-child-context.js";

import type { SessionBootstrap } from "../../../src/cli/runtime/types.js";
import type { SubagentRecord } from "../../../src/contracts/subagent.js";

function parentSession(): SessionBootstrap {
  return {
    sessionId: "parent-session",
    continuationMaxIterations: 73,
    selection: {
      revisionId: () => 0,
      current: () => ({
        entryId: "openai-prod",
        protocolId: "openai-compatible",
        config: { baseURL: "https://example.test/v1" } as never,
        modelId: "gpt-4.1",
      }),
      swap: () => undefined,
      onChange: () => () => undefined,
    },
    projectRoot: "/tmp/project",
    projectTrusted: true,
    securityMode: "ask",
    manifest: { messages: [] } as never,
    resumed: true,
    yolo: false,
    paramsStore: {} as never,
  };
}

function childRecord(): SubagentRecord {
  return {
    parentSessionId: "parent-session",
    subagentId: "child-session",
    depth: 1,
    state: "spawned",
    spawnedAt: 1,
    label: "child",
    requestedEnvelope: ["read"],
    approvedEnvelope: ["read"],
    model: { providerId: "openai-prod", modelId: "gpt-4.1-mini" },
  } as unknown as SubagentRecord;
}

describe("buildChildSession", () => {
  it("inherits the parent continuation budget and project session state", () => {
    const child = buildChildSession(parentSession(), childRecord());

    assert.equal(child.sessionId, "child-session");
    assert.equal(child.continuationMaxIterations, 73);
    assert.equal(child.projectRoot, "/tmp/project");
    assert.equal(child.projectTrusted, true);
    assert.equal(child.securityMode, "ask");
    assert.equal(child.resumed, false);
    assert.equal(child.yolo, false);
    assert.equal(child.manifest.messages.length, 0);
  });

  it("keeps the parent provider selection but applies the child model override", () => {
    const child = buildChildSession(parentSession(), childRecord());
    const selection = child.selection.current();

    assert.equal(selection.entryId, "openai-prod");
    assert.equal(selection.protocolId, "openai-compatible");
    assert.equal(selection.modelId, "gpt-4.1-mini");
  });
});
