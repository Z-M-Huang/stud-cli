import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ToolTerminal, Validation } from "../../../src/core/errors/index.js";
import { createSessionSubagentRegistry } from "../../../src/core/subagent/registry.js";
import {
  openChild,
  validateSpawnArgs,
  type OpenChildContext,
  type ProviderModelLookup,
} from "../../../src/core/subagent/spawn.js";

function permissiveLookup(): ProviderModelLookup {
  return {
    hasProvider: () => true,
    hasModel: (_p, m) => typeof m === "string" && m.length > 0,
    satisfiesRequiredCapabilities: () => true,
  };
}

function strictProviderLookup(parentProviderId: string): ProviderModelLookup {
  return {
    hasProvider: (p) => p === parentProviderId,
    hasModel: (_p, m) => typeof m === "string" && m.length > 0,
    satisfiesRequiredCapabilities: () => true,
  };
}

function buildCtx(overrides: Partial<OpenChildContext> = {}): OpenChildContext {
  return {
    parentSessionId: "parent-session",
    parentDepth: 0,
    maxDepth: 1,
    parentModel: { providerId: "anthropic", modelId: "claude-opus-4-7" },
    activeToolNames: ["read", "edit", "bash"],
    registry: createSessionSubagentRegistry(),
    providerModelLookup: permissiveLookup(),
    now: () => 1_000,
    runChild: () =>
      Promise.resolve({
        outcome: "completed" as const,
        subagentId: "child",
        result: "ok",
        transcriptRef: "subagent:child",
      }),
    ...overrides,
  };
}

describe("validateSpawnArgs — acceptance and model validation", () => {
  it("accepts a minimal valid spawn (envelope omitted)", () => {
    const result = validateSpawnArgs(buildCtx(), { prompt: "do work" });
    assert.equal("ok" in result, true);
    if ("denied" in result) return;
    assert.equal(result.input.depth, 1);
    assert.equal(result.input.model.providerId, "anthropic");
    assert.equal(result.input.model.modelId, "claude-opus-4-7");
    assert.deepEqual(result.input.envelope, []);
  });

  it("rejects when depth cap is reached", () => {
    const result = validateSpawnArgs(buildCtx({ parentDepth: 1, maxDepth: 1 }), {
      prompt: "x",
    });
    assert.equal("denied" in result, true);
    if (!("denied" in result)) return;
    assert.equal(result.denied.context["code"], "Subagent/DepthExceeded");
  });

  it("rejects unknown providerId", () => {
    const result = validateSpawnArgs(
      buildCtx({ providerModelLookup: strictProviderLookup("anthropic") }),
      { prompt: "x", model: { providerId: "openai", modelId: "gpt-4o" } },
    );
    assert.equal("denied" in result, true);
    if (!("denied" in result)) return;
    assert.equal(result.denied.context["code"], "Subagent/ModelInvalid");
  });

  it("rejects unknown modelId under a known provider", () => {
    const result = validateSpawnArgs(
      buildCtx({
        providerModelLookup: {
          hasProvider: () => true,
          hasModel: () => false,
          satisfiesRequiredCapabilities: () => true,
        },
      }),
      { prompt: "x", model: { providerId: "anthropic", modelId: "missing-model" } },
    );
    assert.equal("denied" in result, true);
    if (!("denied" in result)) return;
    assert.equal(result.denied.context["code"], "Subagent/ModelInvalid");
  });

  it("rejects when model arg lacks modelId", () => {
    const result = validateSpawnArgs(buildCtx(), {
      prompt: "x",
      model: { providerId: "anthropic" } as unknown as { providerId: string; modelId: string },
    });
    assert.equal("denied" in result, true);
    if (!("denied" in result)) return;
    assert.equal(result.denied.context["code"], "Validation/InputInvalid");
  });
});

describe("validateSpawnArgs — envelope and capability validation", () => {
  it("rejects envelope members not in the active tool manifest", () => {
    const result = validateSpawnArgs(buildCtx(), {
      prompt: "x",
      requestedEnvelope: ["read", "ssh"],
    });
    assert.equal("denied" in result, true);
    if (!("denied" in result)) return;
    assert.equal(result.denied.context["code"], "Subagent/EnvelopeInvalid");
  });

  it("rejects when capability set is not satisfied", () => {
    const result = validateSpawnArgs(
      buildCtx({
        providerModelLookup: {
          hasProvider: () => true,
          hasModel: () => true,
          satisfiesRequiredCapabilities: () => false,
        },
      }),
      { prompt: "x", requestedEnvelope: ["read"] },
    );
    assert.equal("denied" in result, true);
    if (!("denied" in result)) return;
    assert.equal(result.denied.context["code"], "Subagent/ModelCapabilityMismatch");
  });

  it("rejects prompts that contain forbidden source material", () => {
    const result = validateSpawnArgs(buildCtx(), {
      prompt: "leaked: sk-ant-abc123def-tail",
    });
    assert.equal("denied" in result, true);
    if (!("denied" in result)) return;
    assert.equal(result.denied.context["code"], "ContextContainsForbiddenSource");
  });

  it("populates canonical (providerId, modelId) when override omitted", () => {
    const result = validateSpawnArgs(
      buildCtx({ parentModel: { providerId: "anthropic", modelId: "haiku" } }),
      { prompt: "x" },
    );
    if ("denied" in result) {
      assert.fail("expected ok");
      return;
    }
    assert.equal(result.input.model.providerId, "anthropic");
    assert.equal(result.input.model.modelId, "haiku");
  });

  it("honors a same-provider modelId override", () => {
    const result = validateSpawnArgs(
      buildCtx({
        parentModel: { providerId: "anthropic", modelId: "claude-opus-4-7" },
        providerModelLookup: strictProviderLookup("anthropic"),
      }),
      { prompt: "x", model: { modelId: "claude-haiku-4-5-20251001" } },
    );
    if ("denied" in result) {
      assert.fail("expected ok");
      return;
    }
    assert.equal(result.input.model.providerId, "anthropic");
    assert.equal(result.input.model.modelId, "claude-haiku-4-5-20251001");
  });
});

describe("openChild — success and validation mapping", () => {
  it("delegates to runChild after validation succeeds and unregisters on exit", async () => {
    const registry = createSessionSubagentRegistry();
    let runChildCalled = false;
    const ctx = buildCtx({
      registry,
      runChild: ({ record }) => {
        runChildCalled = true;
        assert.equal(record.parentSessionId, "parent-session");
        assert.equal(record.depth, 1);
        // Registry holds the in-flight record at runChild time.
        assert.equal(registry.size(), 1);
        return Promise.resolve({
          outcome: "completed",
          subagentId: record.subagentId,
          result: "done",
          transcriptRef: `subagent:${record.subagentId}`,
        });
      },
    });
    const result = await openChild(ctx, { prompt: "go" });
    assert.equal(runChildCalled, true);
    assert.equal(result.outcome, "completed");
    // Cleared on terminal.
    assert.equal(registry.size(), 0);
  });

  it("returns aborted with depthExceeded reason when validation fails", async () => {
    const result = await openChild(buildCtx({ parentDepth: 1, maxDepth: 1 }), { prompt: "x" });
    assert.equal(result.outcome, "aborted");
    if (result.outcome !== "aborted") return;
    assert.equal(result.reason, "depthExceeded");
  });

  it("returns aborted with modelInvalid reason on bad provider", async () => {
    const result = await openChild(
      buildCtx({ providerModelLookup: strictProviderLookup("anthropic") }),
      { prompt: "x", model: { providerId: "openai", modelId: "gpt-4o" } },
    );
    assert.equal(result.outcome, "aborted");
    if (result.outcome !== "aborted") return;
    assert.equal(result.reason, "modelInvalid");
  });

  it("returns aborted with envelopeInvalid reason on bad requested envelope", async () => {
    const result = await openChild(buildCtx(), {
      prompt: "x",
      requestedEnvelope: ["ssh"],
    });
    assert.equal(result.outcome, "aborted");
    if (result.outcome !== "aborted") return;
    assert.equal(result.reason, "envelopeInvalid");
  });

  it("returns aborted with modelCapabilityMismatch reason when capability negotiation fails", async () => {
    const result = await openChild(
      buildCtx({
        providerModelLookup: {
          hasProvider: () => true,
          hasModel: () => true,
          satisfiesRequiredCapabilities: () => false,
        },
      }),
      { prompt: "x", requestedEnvelope: ["read"] },
    );
    assert.equal(result.outcome, "aborted");
    if (result.outcome !== "aborted") return;
    assert.equal(result.reason, "modelCapabilityMismatch");
  });

  it("maps other validation failures to providerFailure", async () => {
    const result = await openChild(buildCtx(), { prompt: "sk-ant-abcde" });
    assert.equal(result.outcome, "aborted");
    if (result.outcome !== "aborted") return;
    assert.equal(result.reason, "providerFailure");
  });
});

describe("openChild — runtime cleanup", () => {
  it("forwards the optional label into the spawned record", async () => {
    let seenLabel: string | undefined;
    const result = await openChild(
      buildCtx({
        runChild: ({ record }) => {
          seenLabel = record.label;
          return Promise.resolve({
            outcome: "completed",
            subagentId: record.subagentId,
            result: "done",
            transcriptRef: `subagent:${record.subagentId}`,
          });
        },
      }),
      { prompt: "go", label: "reviewer" },
    );
    assert.equal(result.outcome, "completed");
    assert.equal(seenLabel, "reviewer");
  });

  it("always clears the registry when runChild rejects", async () => {
    const registry = createSessionSubagentRegistry();
    await assert.rejects(
      openChild(
        buildCtx({
          registry,
          runChild: () => Promise.reject(new Error("boom")),
        }),
        { prompt: "go" },
      ),
      /boom/u,
    );
    assert.equal(registry.size(), 0);
  });
});

describe("ToolTerminal/Validation interplay", () => {
  it("forbidden-source rejection wraps Validation in ToolTerminal", () => {
    const result = validateSpawnArgs(buildCtx(), { prompt: "x sk-ant-abcde" });
    assert.equal("denied" in result, true);
    if (!("denied" in result)) return;
    assert.ok(result.denied instanceof ToolTerminal);
    assert.ok(result.denied.cause instanceof Validation);
  });
});
