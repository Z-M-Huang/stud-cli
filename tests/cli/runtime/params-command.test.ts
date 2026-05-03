/**
 * `/params` slash-command dispatch tests.
 *
 * Wiki: contracts/Commands.md § "/params mutation profile";
 *       core/Event-and-Command-Ordering.md § "/params turn-safety";
 *       operations/Audit-Trail.md § "Params" class;
 *       core/Event-Bus.md (`ParamsChanged{paramPath, sourceLayer, redactedDelta, correlationId}`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createActiveSelectionHolder } from "../../../src/cli/runtime/active-selection.js";
import { dispatchParamsCommand } from "../../../src/cli/runtime/params-command.js";
import { buildSessionParamsStore } from "../../../src/cli/runtime/params-runtime.js";

import type { SessionAuditBus } from "../../../src/cli/runtime/audit-bus.js";
import type { ProviderSelection, SessionBootstrap } from "../../../src/cli/runtime/types.js";
import type { HostAPI } from "../../../src/core/host/host-api.js";

interface FakeAuditEvent {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

interface FakeBusEvent {
  readonly name: string;
  readonly payload: unknown;
}

function makeFakeAuditBus(): { readonly bus: SessionAuditBus; readonly events: FakeAuditEvent[] } {
  const events: FakeAuditEvent[] = [];
  const bus: SessionAuditBus = {
    bus: undefined as unknown as SessionAuditBus["bus"],
    emit: (kind, payload) => {
      events.push({ kind, payload });
    },
    withTurn: async (_turnId, fn) => fn(),
    query: () => [],
    activeSubagents: () => [],
    close: async () => {
      /* no-op fake */
    },
  };
  return { bus, events };
}

function makeFakeHost(events: FakeBusEvent[]): {
  readonly events: { emit: (name: string, payload: unknown) => void };
} {
  return {
    events: {
      emit: (name, payload) => {
        events.push({ name, payload });
      },
    },
  };
}

function fakeSession(
  selection: ProviderSelection,
  defaultParams?: Readonly<Record<string, unknown>>,
): SessionBootstrap {
  const paramsStore = buildSessionParamsStore(defaultParams, []);
  return {
    sessionId: "s-test",
    selection: createActiveSelectionHolder(selection),
    projectRoot: "/tmp/x",
    projectTrusted: true,
    securityMode: "ask",
    manifest: {
      sessionId: "s-test",
      projectRoot: "/tmp/x",
      mode: "ask",
      messages: [],
      storeId: "filesystem-session-store",
      createdAt: 0,
      updatedAt: 0,
    },
    resumed: false,
    yolo: false,
    paramsStore,
  };
}

const ANTHROPIC_SELECTION: ProviderSelection = {
  entryId: "anthropic-prod",
  protocolId: "anthropic",
  modelId: "claude-opus-4-7",
  config: {
    protocol: "anthropic",
    apiKeyRef: { kind: "env", name: "X_KEY" },
    models: ["claude-opus-4-7"],
  } as unknown as ProviderSelection["config"],
};

const OPENAI_SELECTION: ProviderSelection = {
  entryId: "openai-prod",
  protocolId: "openai-compatible",
  modelId: "gpt-5.1",
  config: {
    protocol: "openai-compatible",
    apiKeyRef: { kind: "env", name: "X_KEY" },
    models: ["gpt-5.1"],
  } as unknown as ProviderSelection["config"],
};

describe("dispatchParamsCommand — read mode", () => {
  it("reports '(no params set)' when store is empty", () => {
    const { bus } = makeFakeAuditBus();
    const session = fakeSession(ANTHROPIC_SELECTION);
    const result = dispatchParamsCommand({ session, auditBus: bus, tokens: [] });
    assert.equal(result.kind, "ok");
    assert.equal(result.notify, "(no params set)");
  });

  it("prints effective merged view sorted with provenance tag", () => {
    const { bus } = makeFakeAuditBus();
    const session = fakeSession(ANTHROPIC_SELECTION, { effort: "high" });
    session.paramsStore.set(["temperature"], 0.5, "/params");
    const result = dispatchParamsCommand({ session, auditBus: bus, tokens: [] });
    assert.equal(result.kind, "ok");
    assert.match(result.notify, /effort="high"\s+\[defaultParams\]/u);
    assert.match(result.notify, /temperature=0\.5\s+\[\/params\]/u);
  });
});

describe("dispatchParamsCommand — mid-Act refusal", () => {
  it("rejects with StageActive when activeStageStep === 'Act'", () => {
    const { bus } = makeFakeAuditBus();
    const session = fakeSession(ANTHROPIC_SELECTION);
    const result = dispatchParamsCommand({
      session,
      auditBus: bus,
      activeStageStep: "Act",
      tokens: ["effort=medium"],
    });
    assert.equal(result.kind, "rejected");
    assert.equal(result.reason?.code, "StageActive");
  });

  it("allows the write when activeStageStep is null (no SM attached)", () => {
    const { bus } = makeFakeAuditBus();
    const session = fakeSession(ANTHROPIC_SELECTION, { effort: "low" });
    const result = dispatchParamsCommand({
      session,
      auditBus: bus,
      activeStageStep: null,
      tokens: ["effort=medium"],
    });
    assert.equal(result.kind, "ok");
  });

  it("allows the write between stages (Init/Setup/Assert/Exit)", () => {
    for (const step of ["Init", "Setup", "Assert", "Exit"] as const) {
      const { bus } = makeFakeAuditBus();
      const session = fakeSession(ANTHROPIC_SELECTION, { effort: "low" });
      const result = dispatchParamsCommand({
        session,
        auditBus: bus,
        activeStageStep: step,
        tokens: ["effort=medium"],
      });
      assert.equal(result.kind, "ok");
    }
  });
});

describe("dispatchParamsCommand — write mode", () => {
  it("validates each pair and persists on success", () => {
    const { bus } = makeFakeAuditBus();
    const session = fakeSession(OPENAI_SELECTION, { temperature: 0.7 });
    const result = dispatchParamsCommand({
      session,
      auditBus: bus,
      tokens: ["temperature=0.5"],
    });
    assert.equal(result.kind, "ok");
    assert.equal(session.paramsStore.get(["temperature"])?.value, 0.5);
    assert.equal(session.paramsStore.get(["temperature"])?.sourceLayer, "/params");
  });

  it("rejects atomically when validation fails — store unchanged", () => {
    const { bus } = makeFakeAuditBus();
    const session = fakeSession(OPENAI_SELECTION, { temperature: 0.7 });
    const result = dispatchParamsCommand({
      session,
      auditBus: bus,
      tokens: ["temperature=hot"], // invalid type
    });
    assert.equal(result.kind, "rejected");
    assert.equal(session.paramsStore.get(["temperature"])?.value, 0.7);
    assert.equal(session.paramsStore.get(["temperature"])?.sourceLayer, "defaultParams");
  });

  it("emits one Params audit record per mutated path", () => {
    const { bus, events } = makeFakeAuditBus();
    const session = fakeSession(OPENAI_SELECTION, { temperature: 0.7, topP: 0.9 });
    dispatchParamsCommand({
      session,
      auditBus: bus,
      tokens: ["temperature=0.5", "topP=0.8"],
    });
    const params = events.filter((e) => e.kind === "Params");
    assert.equal(params.length, 2);
    assert.equal((params[0]?.payload as { kind: string }).kind, "ParamsChanged");
    assert.equal((params[0]?.payload as { sourceLayer: string }).sourceLayer, "/params");
  });

  it("emits one ParamsChanged event per mutated path with shared correlationId", () => {
    const { bus } = makeFakeAuditBus();
    const session = fakeSession(OPENAI_SELECTION, { temperature: 0.7, topP: 0.9 });
    const events: FakeBusEvent[] = [];
    const host = makeFakeHost(events);
    dispatchParamsCommand({
      session,
      auditBus: bus,
      host: host as unknown as HostAPI,
      tokens: ["temperature=0.5", "topP=0.8"],
    });
    const paramsEvents = events.filter((e) => e.name === "ParamsChanged");
    assert.equal(paramsEvents.length, 2);
    const cids = paramsEvents.map((e) => (e.payload as { correlationId?: string }).correlationId);
    assert.ok(cids[0]?.startsWith("params:"));
    assert.equal(cids[0], cids[1]); // shared per-invocation correlationId
  });

  it("ParamsChanged event payload carries paramPath, sourceLayer, redactedDelta, correlationId", () => {
    const { bus } = makeFakeAuditBus();
    const session = fakeSession(OPENAI_SELECTION);
    const events: FakeBusEvent[] = [];
    const host = makeFakeHost(events);
    dispatchParamsCommand({
      session,
      auditBus: bus,
      host: host as unknown as HostAPI,
      tokens: ["temperature=0.5"],
    });
    const evt = events.find((e) => e.name === "ParamsChanged");
    const p = evt?.payload as {
      readonly paramPath: readonly string[];
      readonly sourceLayer: string;
      readonly redactedDelta: unknown;
      readonly correlationId: string;
    };
    assert.deepEqual(p.paramPath, ["temperature"]);
    assert.equal(p.sourceLayer, "/params");
    assert.equal(p.redactedDelta, 0.5);
    assert.match(p.correlationId, /^params:/u);
  });
});
