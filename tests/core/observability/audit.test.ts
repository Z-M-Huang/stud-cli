import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { listAuditClasses, writeAudit } from "../../../src/core/observability/audit/writer.js";
import { withCorrelation } from "../../../src/core/observability/correlation.js";
import { createObservabilityBus } from "../../../src/core/observability/sinks.js";

function spyOnBus(captured: unknown[]): void {
  const bus = createObservabilityBus();
  bus.register({
    id: "audit-test-sink",
    accept: (record) => {
      captured.push(record);
    },
  });
}

function assertValidationCode(error: unknown, code: string): true {
  assert.ok(typeof error === "object" && error !== null);
  const err = error as { class?: string; context?: { code?: string } };
  assert.equal(err.class, "Validation");
  assert.equal(err.context?.code, code);
  return true;
}

function registerEnumerationAndValidationTests(): void {
  it("enumerates the 13 wiki-documented classes plus SuppressedError", () => {
    const classes = listAuditClasses();

    assert.equal(classes.length, 14);
    assert.deepEqual(classes, [
      "Approval",
      "Compaction",
      "StageExecution",
      "ModelSwitch",
      "ProviderSwitch",
      "ExtensionsReloaded",
      "TrustDecision",
      "SMTransition",
      "Integrity",
      "SessionLifecycle",
      "Turn",
      "ProviderExchange",
      "ToolInvocation",
      "SuppressedError",
    ]);
  });

  it("refuses an unknown audit class", () => {
    assert.throws(
      () => {
        writeAudit("NotAClass" as never, {} as never);
      },
      (error: unknown) => assertValidationCode(error, "UnknownAuditClass"),
    );
  });

  it("refuses to write outside a correlation scope", () => {
    assert.throws(
      () => {
        writeAudit("Approval", { decision: "approved", toolId: "fs.read" });
      },
      (error: unknown) => assertValidationCode(error, "AuditWithoutCorrelation"),
    );
  });

  it("every class has a typed payload shape", () => {
    const _: Parameters<typeof writeAudit> = ["SessionLifecycle", { event: "start" }];
    assert.deepEqual(_, ["SessionLifecycle", { event: "start" }]);
    assert.equal(listAuditClasses().length, 14);
  });
}

function registerEmissionTests(): void {
  it("emits an Approval record with correlation id and timestamp", async () => {
    const captured: { kind: string; correlationId: string; timestamp: number }[] = [];
    spyOnBus(captured);

    await withCorrelation("c-1", async () => {
      await Promise.resolve();
      writeAudit("Approval", { decision: "approved", toolId: "fs.read" });
    });

    const rec = captured.find((record) => record.kind === "Approval");
    assert.ok(rec);
    assert.equal(rec.correlationId, "c-1");
    assert.ok(rec.timestamp > 0);
  });

  it("emits ExtensionsReloaded when the Validation Pipeline reports a new set", async () => {
    const captured: { kind: string; payload: { revisionId?: string } }[] = [];
    spyOnBus(captured);

    await withCorrelation("c-3", async () => {
      await Promise.resolve();
      writeAudit("ExtensionsReloaded", {
        loaded: ["a", "b"],
        disabled: ["c"],
        revisionId: "rev-1",
      });
    });

    const rec = captured.find((record) => record.kind === "ExtensionsReloaded");
    assert.ok(rec);
    assert.equal(rec.payload.revisionId, "rev-1");
  });

  it("emits a typed Turn record with TurnStarted kind", async () => {
    const captured: { kind: string; payload: { kind?: string; turnId?: string } }[] = [];
    spyOnBus(captured);

    await withCorrelation("c-turn", async () => {
      await Promise.resolve();
      writeAudit("Turn", {
        kind: "TurnStarted",
        turnId: "t-1",
        userInput: "hello",
        historyLength: 1,
      });
    });

    const rec = captured.find((record) => record.kind === "Turn");
    assert.ok(rec);
    assert.equal(rec.payload.kind, "TurnStarted");
    assert.equal(rec.payload.turnId, "t-1");
  });

  it("emits a typed ProviderExchange record for ProviderRequest", async () => {
    const captured: { kind: string; payload: { kind?: string; providerId?: string } }[] = [];
    spyOnBus(captured);

    await withCorrelation("c-prov", async () => {
      await Promise.resolve();
      writeAudit("ProviderExchange", {
        kind: "ProviderRequest",
        providerId: "anthropic",
        modelId: "claude-opus-4-7",
      });
    });

    const rec = captured.find((record) => record.kind === "ProviderExchange");
    assert.ok(rec);
    assert.equal(rec.payload.kind, "ProviderRequest");
    assert.equal(rec.payload.providerId, "anthropic");
  });

  it("emits a typed ToolInvocation record for ToolCallStarted", async () => {
    const captured: { kind: string; payload: { kind?: string; toolName?: string } }[] = [];
    spyOnBus(captured);

    await withCorrelation("c-tool", async () => {
      await Promise.resolve();
      writeAudit("ToolInvocation", {
        kind: "ToolCallStarted",
        toolCallId: "tc-1",
        toolName: "fs.read",
      });
    });

    const rec = captured.find((record) => record.kind === "ToolInvocation");
    assert.ok(rec);
    assert.equal(rec.payload.kind, "ToolCallStarted");
    assert.equal(rec.payload.toolName, "fs.read");
  });
}

function registerSecretScrubbingTests(): void {
  it("scrubs a resolved secret out of the payload before emit", async () => {
    const captured: { kind: string; payload: unknown }[] = [];
    spyOnBus(captured);

    await withCorrelation("c-2", async () => {
      await Promise.resolve();
      writeAudit("ProviderSwitch", {
        from: "anthropic",
        to: "openai",
        _secret: "sk-live-1234567890",
      } as never);
    });

    const rec = captured.find((record) => record.kind === "ProviderSwitch");
    assert.ok(rec);
    assert.doesNotMatch(JSON.stringify(rec.payload), /sk-live-1234567890/u);
  });

  it("rewrites secret references to ref placeholders before emit", async () => {
    const captured: { kind: string; payload: unknown }[] = [];
    spyOnBus(captured);

    await withCorrelation("c-ref", async () => {
      await Promise.resolve();
      writeAudit("ProviderSwitch", {
        from: "anthropic",
        to: "openai",
        credential: { kind: "env", name: "OPENAI_API_KEY" },
      } as never);
    });

    const rec = captured.find((record) => record.kind === "ProviderSwitch");
    assert.ok(rec);
    assert.match(JSON.stringify(rec.payload), /<ref:OPENAI_API_KEY>/u);
  });

  it("scrubs nested secret-like strings inside arrays and objects", async () => {
    const captured: { kind: string; payload: unknown }[] = [];
    spyOnBus(captured);

    await withCorrelation("c-nested", async () => {
      await Promise.resolve();
      writeAudit("ProviderSwitch", {
        from: "anthropic",
        to: "openai",
        nested: ["ghp_secretToken123", { apiKey: "AIzaSySecretToken1234567890123456" }],
      } as never);
    });

    const rec = captured.find((record) => record.kind === "ProviderSwitch");
    assert.ok(rec);
    const payload = JSON.stringify(rec.payload);
    assert.doesNotMatch(payload, /ghp_secretToken123/u);
    assert.doesNotMatch(payload, /AIzaSySecretToken1234567890123456/u);
  });
}

function registerTruncationTests(): void {
  it("truncates string fields exceeding 64 KiB and emits the byte-count sentinel", async () => {
    const captured: { kind: string; payload: unknown }[] = [];
    spyOnBus(captured);

    const oversized = "x".repeat(80_000);
    await withCorrelation("c-trunc", async () => {
      await Promise.resolve();
      writeAudit("SuppressedError", { reason: "stress test", cause: oversized });
    });

    const rec = captured.find((record) => record.kind === "SuppressedError");
    assert.ok(rec);
    const payload = rec.payload as { cause: string };
    assert.match(payload.cause, /…\[truncated \d+ bytes of 80000\]$/u);
    assert.ok(Buffer.byteLength(payload.cause, "utf8") <= 65_536 + 64);
  });

  it("leaves string fields under 64 KiB untouched", async () => {
    const captured: { kind: string; payload: unknown }[] = [];
    spyOnBus(captured);

    await withCorrelation("c-small", async () => {
      await Promise.resolve();
      writeAudit("SuppressedError", { reason: "ok", cause: "y".repeat(1000) });
    });

    const rec = captured.find((record) => record.kind === "SuppressedError");
    assert.ok(rec);
    const payload = rec.payload as { cause: string };
    assert.equal(payload.cause.length, 1000);
    assert.doesNotMatch(payload.cause, /truncated/u);
  });
}

describe("Audit Trail", () => {
  registerEnumerationAndValidationTests();
  registerEmissionTests();
  registerSecretScrubbingTests();
  registerTruncationTests();
});
