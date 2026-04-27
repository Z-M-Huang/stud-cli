import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  __attachSMForTest,
  __detachSMForTest,
  __initializeDiagnosticsForTest,
  __primeMCPHistoryForTest,
  __resetDiagnosticsForTest,
  __setLoopSnapshotForTest,
  probe,
  snapshotReport,
} from "../../../src/core/diagnostics/probe.js";
import { clearRegistry, registerServer } from "../../../src/core/mcp/client.js";

beforeEach(() => {
  __resetDiagnosticsForTest();
  clearRegistry();
  __initializeDiagnosticsForTest({
    activeStore: "fs.reference",
    activeInteractor: "ui.default",
    mode: "ask",
    extensions: [
      { id: "cmd.health", kind: "command", state: "loaded" },
      { id: "ui.default", kind: "ui", state: "loaded" },
      { id: "logger.file", kind: "logger", state: "disabled" },
    ],
  });
  __setLoopSnapshotForTest({ turnCount: 4, lastCorrelationId: "corr-4" });
});

afterEach(() => {
  __resetDiagnosticsForTest();
  clearRegistry();
});

function registerFixtureServer(id: string, scope: "bundled" | "global" | "project"): void {
  registerServer({
    id,
    transport: "stdio",
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    scope,
  });
}

describe("health probe", () => {
  it("returns the  shape with every required key", async () => {
    registerFixtureServer("srv-1", "bundled");

    const report = await probe();

    assert.equal(Array.isArray(report.extensions), true);
    assert.equal(typeof report.activeStore, "string");
    assert.equal(typeof report.activeInteractor, "string");
    assert.equal(["ask", "yolo", "allowlist"].includes(report.mode), true);
    assert.equal(Array.isArray(report.mcp), true);
    assert.equal(typeof report.loop.turnCount, "number");
    assert.ok("extensions" in report);
    assert.ok("activeStore" in report);
    assert.ok("activeInteractor" in report);
    assert.ok("mode" in report);
    assert.ok("mcp" in report);
    assert.ok("loop" in report);
  });

  it("is read-only (calling twice does not change state)", async () => {
    registerFixtureServer("srv-1", "bundled");

    const first = await probe();
    const second = await probe();

    assert.equal(first.loop.turnCount, second.loop.turnCount);
    assert.equal(first.loop.lastCorrelationId, second.loop.lastCorrelationId);
    assert.deepEqual(first.extensions, second.extensions);
    assert.deepEqual(first.mcp, second.mcp);
  });

  it("reflects the last MCP connect/disconnect audit for healthy flag", async () => {
    registerFixtureServer("srv-1", "global");
    registerFixtureServer("srv-2", "project");
    __primeMCPHistoryForTest([
      { server: "srv-1", connected: true },
      { server: "srv-2", connected: false },
    ]);

    const report = await probe();

    assert.equal(report.mcp.find((entry) => entry.server === "srv-1")?.healthy, true);
    assert.equal(report.mcp.find((entry) => entry.server === "srv-2")?.healthy, false);
  });

  it("returns sm undefined when no SM is attached", async () => {
    __detachSMForTest();

    const report = await probe();

    assert.equal(report.sm, undefined);
  });

  it("returns sm populated when one is attached", async () => {
    __attachSMForTest({ smId: "sm-demo", currentStageId: "stage-1", depth: 1 });

    const report = await probe();

    assert.equal(report.sm?.smId, "sm-demo");
    assert.equal(report.sm?.currentStageId, "stage-1");
    assert.equal(report.sm?.depth, 1);
  });

  it("snapshotReport renders a deterministic string", async () => {
    registerFixtureServer("srv-1", "bundled");
    __attachSMForTest({ smId: "sm-demo", currentStageId: "stage-1", depth: 1 });

    const report = await probe();
    const first = snapshotReport(report);
    const second = snapshotReport(report);

    assert.equal(typeof first, "string");
    assert.equal(first, second);
  });

  it("refuses to probe before registries are initialized", async () => {
    __resetDiagnosticsForTest();

    await assert.rejects(
      () => probe(),
      (error: unknown) => {
        assert.equal((error as { class?: string }).class, "Session");
        assert.equal((error as { context?: { code?: string } }).context?.code, "StateUnavailable");
        return true;
      },
    );
  });
});
