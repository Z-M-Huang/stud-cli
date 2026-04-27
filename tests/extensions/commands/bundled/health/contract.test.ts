/**
 * Contract conformance tests for the /health bundled command.
 *
 * Covers: shape,  report schema, SM-optional field, unhealthy MCP
 * servers, no-resolved-secrets invariant, and lifecycle ordering.
 *
 * Uses node:test + node:assert/strict (project canonical test runner).
 *
 * Wiki: operations/Health-and-Diagnostics.md + reference-extensions/commands/health.md
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  __attachSMForTest,
  __detachSMForTest,
  __initializeDiagnosticsForTest,
  __primeMCPHistoryForTest,
  __resetDiagnosticsForTest,
  __setLoopSnapshotForTest,
} from "../../../../../src/core/diagnostics/probe.js";
import { clearRegistry, registerServer } from "../../../../../src/core/mcp/client.js";
import { contract } from "../../../../../src/extensions/commands/bundled/health/index.js";
import { mockHost } from "../../../../helpers/mock-host.js";

import type { CommandArgs } from "../../../../../src/contracts/commands.js";
import type { HealthReport } from "../../../../../src/extensions/commands/bundled/health/report.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Minimal valid CommandArgs for a bare /health invocation (no args). */
const EMPTY_ARGS: CommandArgs = { raw: "", positional: [], flags: {} };

function initDefaultState(): void {
  __initializeDiagnosticsForTest({
    activeStore: "filesystem",
    activeInteractor: "default-tui",
    mode: "ask",
    extensions: [{ id: "e1", kind: "tools", state: "loaded" }],
  });
  __setLoopSnapshotForTest({ turnCount: 4, lastCorrelationId: "c-abc" });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetDiagnosticsForTest();
  clearRegistry();
  initDefaultState();
});

afterEach(() => {
  __resetDiagnosticsForTest();
  clearRegistry();
});

// ---------------------------------------------------------------------------
// Shape / contract declaration tests
// ---------------------------------------------------------------------------

describe("/health command — shape", () => {
  it("declares Command category", () => {
    assert.equal(contract.kind, "Command");
  });

  it("declares name /health", () => {
    assert.equal(contract.name, "/health");
  });

  it("declares a semver contractVersion", () => {
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
  });

  it("declares a non-empty requiredCoreVersion range", () => {
    assert.ok(contract.requiredCoreVersion.length > 0);
  });

  it("has no state slot (stateless command)", () => {
    assert.equal(contract.stateSlot, null);
  });

  it("has loadedCardinality unlimited", () => {
    assert.equal(contract.loadedCardinality, "unlimited");
  });

  it("has activeCardinality unlimited", () => {
    assert.equal(contract.activeCardinality, "unlimited");
  });

  it("has a non-empty description", () => {
    assert.ok(typeof contract.description === "string" && contract.description.length > 0);
  });

  it("has a parseable configSchema", () => {
    assert.equal(typeof contract.configSchema, "object");
    assert.equal((contract.configSchema as { type?: string }).type, "object");
  });

  it("is not approval-gated", () => {
    // Commands are dispatched through the interactor, never through the SM
    // approval gate. The /health contract carries no requiresApproval field.
    const contractRecord = contract as unknown as Record<string, unknown>;
    assert.notEqual(contractRecord["requiresApproval"], true);
  });
});

// ---------------------------------------------------------------------------
// report shape
// ---------------------------------------------------------------------------

describe("/health command —  report shape", () => {
  it("returns all required top-level keys from ", async () => {
    const { host } = mockHost({ extId: "health" });
    await contract.lifecycle.init?.(host, { enabled: true });
    const result = await contract.execute(EMPTY_ARGS, host);
    const r = result.payload as unknown as HealthReport;

    assert.ok(Array.isArray(r.extensions), "extensions must be an array");
    assert.ok(typeof r.activeStore === "string", "activeStore must be a string");
    assert.ok(typeof r.activeInteractor === "string", "activeInteractor must be a string");
    assert.ok(["ask", "yolo", "allowlist"].includes(r.mode), "mode must be a valid SecurityMode");
    assert.ok(Array.isArray(r.mcp), "mcp must be an array");
    assert.ok(typeof r.loop.turnCount === "number", "loop.turnCount must be a number");
  });

  it("returns activeStore and activeInteractor from the probe", async () => {
    const { host } = mockHost({ extId: "health" });
    await contract.lifecycle.init?.(host, { enabled: true });
    const result = await contract.execute(EMPTY_ARGS, host);
    const r = result.payload as unknown as HealthReport;

    assert.equal(r.activeStore, "filesystem");
    assert.equal(r.activeInteractor, "default-tui");
  });

  it("returns mode from the probe", async () => {
    const { host } = mockHost({ extId: "health" });
    await contract.lifecycle.init?.(host, { enabled: true });
    const result = await contract.execute(EMPTY_ARGS, host);
    const r = result.payload as unknown as HealthReport;

    assert.equal(r.mode, "ask");
  });

  it("returns loop turnCount and lastCorrelationId from the probe", async () => {
    const { host } = mockHost({ extId: "health" });
    await contract.lifecycle.init?.(host, { enabled: true });
    const result = await contract.execute(EMPTY_ARGS, host);
    const r = result.payload as unknown as HealthReport;

    assert.equal(r.loop.turnCount, 4);
    assert.equal(r.loop.lastCorrelationId, "c-abc");
  });

  it("includes rendered output string", async () => {
    const { host } = mockHost({ extId: "health" });
    await contract.lifecycle.init?.(host, { enabled: true });
    const result = await contract.execute(EMPTY_ARGS, host);

    assert.ok(typeof result.rendered === "string" && result.rendered.length > 0);
  });
});

// ---------------------------------------------------------------------------
// SM optional field
// ---------------------------------------------------------------------------

describe("/health command — SM optional field", () => {
  it("omits sm field when no SM is attached", async () => {
    __detachSMForTest();
    const { host } = mockHost({ extId: "health" });
    await contract.lifecycle.init?.(host, { enabled: true });
    const result = await contract.execute(EMPTY_ARGS, host);
    const r = result.payload as unknown as HealthReport;

    assert.equal(r.sm, undefined);
  });

  it("includes sm field when an SM is attached", async () => {
    __attachSMForTest({ smId: "ralph", currentStageId: "build", depth: 1 });
    const { host } = mockHost({ extId: "health" });
    await contract.lifecycle.init?.(host, { enabled: true });
    const result = await contract.execute(EMPTY_ARGS, host);
    const r = result.payload as unknown as HealthReport;

    assert.ok(r.sm !== undefined, "sm must be present when an SM is attached");
    assert.equal(r.sm.smId, "ralph");
    assert.equal(r.sm.currentStageId, "build");
  });
});

// ---------------------------------------------------------------------------
// MCP health
// ---------------------------------------------------------------------------

describe("/health command — MCP health", () => {
  it("reports unhealthy MCP servers without throwing", async () => {
    registerServer({
      id: "gh",
      transport: "stdio",
      command: process.execPath,
      scope: "global",
    });
    __primeMCPHistoryForTest([{ server: "gh", connected: false }]);

    const { host } = mockHost({ extId: "health" });
    await contract.lifecycle.init?.(host, { enabled: true });
    const result = await contract.execute(EMPTY_ARGS, host);
    const r = result.payload as unknown as HealthReport;
    const entry = r.mcp.find((m) => m.server === "gh");

    assert.ok(entry !== undefined, "gh server must appear in mcp list");
    assert.equal(entry.healthy, false);
  });

  it("reports healthy MCP servers", async () => {
    registerServer({
      id: "gh",
      transport: "stdio",
      command: process.execPath,
      scope: "global",
    });
    __primeMCPHistoryForTest([{ server: "gh", connected: true }]);

    const { host } = mockHost({ extId: "health" });
    await contract.lifecycle.init?.(host, { enabled: true });
    const result = await contract.execute(EMPTY_ARGS, host);
    const r = result.payload as unknown as HealthReport;
    const entry = r.mcp.find((m) => m.server === "gh");

    assert.ok(entry !== undefined, "gh server must appear in mcp list");
    assert.equal(entry.healthy, true);
  });

  it("includes trusted flag on MCP entries", async () => {
    registerServer({
      id: "bundled-srv",
      transport: "stdio",
      command: process.execPath,
      scope: "bundled",
    });

    const { host } = mockHost({ extId: "health" });
    await contract.lifecycle.init?.(host, { enabled: true });
    const result = await contract.execute(EMPTY_ARGS, host);
    const r = result.payload as unknown as HealthReport;
    const entry = r.mcp.find((m) => m.server === "bundled-srv");

    assert.ok(entry !== undefined, "bundled-srv must appear in mcp list");
    assert.equal(entry.trusted, true);
  });
});

// ---------------------------------------------------------------------------
// No resolved secrets ( / invariant #6)
// ---------------------------------------------------------------------------

describe("/health command — no resolved secrets", () => {
  it("never includes resolved secrets in the report", async () => {
    // Env secrets are never read by the probe; the execute function does not
    // touch host.env. This test verifies end-to-end that no secret value
    // supplied via env appears in the serialised output.
    const { host } = mockHost({ extId: "health", env: { SECRET_TOKEN: "sk-absolutely-real" } });
    await contract.lifecycle.init?.(host, { enabled: true });
    const result = await contract.execute(EMPTY_ARGS, host);
    const serialized = JSON.stringify(result.payload);

    assert.ok(
      !serialized.includes("sk-absolutely-real"),
      "report must not contain resolved secret value",
    );
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("/health command — lifecycle", () => {
  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "health" });
    await contract.lifecycle.dispose?.(host);
    await contract.lifecycle.dispose?.(host);
  });

  it("runs lifecycle in order without error", async () => {
    const { host } = mockHost({ extId: "health" });
    const order: string[] = [];

    await contract.lifecycle.init?.(host, { enabled: true });
    order.push("init");
    await contract.lifecycle.dispose?.(host);
    order.push("dispose");

    assert.deepEqual(order, ["init", "dispose"]);
  });
});
