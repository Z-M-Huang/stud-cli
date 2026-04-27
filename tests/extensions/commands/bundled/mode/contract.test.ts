/**
 * Contract conformance tests for the /mode bundled command.
 *
 * Covers: shape, session-mode read, arg-rejection invariant (#3), mode
 * non-mutation, rendered output, and lifecycle ordering.
 *
 * Uses node:test + node:assert/strict (project canonical test runner).
 *
 * Wiki: reference-extensions/commands/mode.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contract } from "../../../../../src/extensions/commands/bundled/mode/index.js";
import { mockHost } from "../../../../helpers/mock-host.js";

import type { CommandArgs } from "../../../../../src/contracts/commands.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Minimal valid CommandArgs for a bare /mode invocation (no args). */
const EMPTY_ARGS: CommandArgs = { raw: "", positional: [], flags: {} };

/** CommandArgs simulating `/mode yolo` (mode-change attempt). */
const YOLO_ARGS: CommandArgs = { raw: "yolo", positional: ["yolo"], flags: {} };

/** CommandArgs simulating `/mode --mode=yolo` (flag-based mode-change attempt). */
const FLAGS_ARGS: CommandArgs = { raw: "--mode=yolo", positional: [], flags: { mode: "yolo" } };

// ---------------------------------------------------------------------------
// Shape / contract declaration tests
// ---------------------------------------------------------------------------

describe("/mode command — shape", () => {
  it("declares Command category", () => {
    assert.equal(contract.kind, "Command");
  });

  it("declares name /mode", () => {
    assert.equal(contract.name, "/mode");
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
    // Command extensions are dispatched through the interactor and never through
    // the SM approval gate. The /mode contract carries no requiresApproval field.
    const contractRecord = contract as unknown as Record<string, unknown>;
    assert.notEqual(contractRecord["requiresApproval"], true);
  });
});

// ---------------------------------------------------------------------------
// Execution tests ( /mode scope +  approval-free read)
// ---------------------------------------------------------------------------

describe("/mode command — execution", () => {
  it("returns the session-fixed mode", async () => {
    const { host } = mockHost({ extId: "mode", mode: "ask" });
    await contract.lifecycle.init?.(host, { enabled: true });
    const result = await contract.execute(EMPTY_ARGS, host);
    const output = result.payload as { mode?: unknown; sessionFixed?: unknown };
    assert.equal(output.mode, "ask");
    assert.equal(output.sessionFixed, true);
  });

  it("returns sessionFixed: true and setAt: session-start", async () => {
    const { host } = mockHost({ extId: "mode", mode: "ask" });
    await contract.lifecycle.init?.(host, { enabled: true });
    const result = await contract.execute(EMPTY_ARGS, host);
    const output = result.payload as { setAt?: unknown; sessionFixed?: unknown };
    assert.equal(output.setAt, "session-start");
    assert.equal(output.sessionFixed, true);
  });

  it("returns the session-fixed mode for yolo mode", async () => {
    const { host } = mockHost({ extId: "mode", mode: "yolo" });
    await contract.lifecycle.init?.(host, { enabled: true });
    const result = await contract.execute(EMPTY_ARGS, host);
    const output = result.payload as { mode?: unknown };
    assert.equal(output.mode, "yolo");
  });

  it("returns the session-fixed mode for allowlist mode", async () => {
    const { host } = mockHost({ extId: "mode", mode: "allowlist" });
    await contract.lifecycle.init?.(host, { enabled: true });
    const result = await contract.execute(EMPTY_ARGS, host);
    const output = result.payload as { mode?: unknown };
    assert.equal(output.mode, "allowlist");
  });

  it("rejects any positional argument with ToolTerminal/InputInvalid (no runtime mode change)", async () => {
    const { host } = mockHost({ extId: "mode", mode: "ask" });
    await contract.lifecycle.init?.(host, { enabled: true });
    await assert.rejects(
      () => contract.execute(YOLO_ARGS, host),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "ToolTerminal");
        assert.equal((err as { context?: { code?: unknown } }).context?.code, "InputInvalid");
        return true;
      },
    );
  });

  it("rejects flag arguments with ToolTerminal/InputInvalid (no runtime mode change via flags)", async () => {
    const { host } = mockHost({ extId: "mode", mode: "ask" });
    await contract.lifecycle.init?.(host, { enabled: true });
    await assert.rejects(
      () => contract.execute(FLAGS_ARGS, host),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "ToolTerminal");
        assert.equal((err as { context?: { code?: unknown } }).context?.code, "InputInvalid");
        return true;
      },
    );
  });

  it("never mutates host.session.mode after invocation", async () => {
    const { host } = mockHost({ extId: "mode", mode: "ask" });
    await contract.lifecycle.init?.(host, { enabled: true });
    await contract.execute(EMPTY_ARGS, host);
    assert.equal(host.session.mode, "ask");
  });

  it("rendered output contains the mode name", async () => {
    const { host } = mockHost({ extId: "mode", mode: "allowlist" });
    await contract.lifecycle.init?.(host, { enabled: true });
    const result = await contract.execute(EMPTY_ARGS, host);
    assert.ok(
      result.rendered.includes("allowlist"),
      `Expected rendered output to include "allowlist", got: ${result.rendered}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Lifecycle tests
// ---------------------------------------------------------------------------

describe("/mode command — lifecycle", () => {
  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "mode" });
    await contract.lifecycle.dispose?.(host);
    await contract.lifecycle.dispose?.(host);
  });

  it("runs lifecycle in order without error", async () => {
    const { host } = mockHost({ extId: "mode" });
    const order: string[] = [];

    await contract.lifecycle.init?.(host, { enabled: true });
    order.push("init");
    await contract.lifecycle.dispose?.(host);
    order.push("dispose");

    assert.deepEqual(order, ["init", "dispose"]);
  });
});
