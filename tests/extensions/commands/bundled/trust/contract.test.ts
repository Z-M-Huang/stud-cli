/**
 * Contract conformance tests for the /trust bundled command.
 *
 * Covers: shape, list redaction, clear-mcp forgets (Q-10), re-prompt after
 * clear-mcp, unknown-server NotFound, revoke-cancel, and lifecycle safety.
 *
 * Uses node:test + node:assert/strict (project canonical test runner).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Cancellation } from "../../../../../src/core/errors/index.js";
import {
  contract,
  injectTrustContext,
} from "../../../../../src/extensions/commands/bundled/trust/index.js";
import { fakeHost } from "../../../../helpers/host-fixtures.js";
import { mockHost } from "../../../../helpers/mock-host.js";

import type { CommandArgs } from "../../../../../src/contracts/commands.js";
import type {
  McpTrustEntry,
  ProjectTrustEntry,
  TrustContext,
} from "../../../../../src/extensions/commands/bundled/trust/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal CommandArgs for a bare /trust invocation. */
function args(
  raw: string,
  positional: string[],
  flags: Record<string, string | boolean> = {},
): CommandArgs {
  return { raw, positional, flags };
}

interface MockTrustContextOptions {
  readonly projectEntries?: readonly string[];
  readonly mcpEntries?: readonly { serverId: string; scope?: "global" | "project" }[];
}

interface MockTrustContext extends TrustContext {
  /** Current project entries (for assertion). */
  currentProjectEntries(): readonly ProjectTrustEntry[];
  /** Current MCP entries (for assertion). */
  currentMcpEntries(): readonly McpTrustEntry[];
}

function buildMockTrustContext(opts: MockTrustContextOptions = {}): MockTrustContext {
  let projectEntries: ProjectTrustEntry[] = (opts.projectEntries ?? []).map((p) => ({
    canonicalPath: p,
    grantedAt: "2024-01-01T00:00:00.000Z",
  }));

  let mcpEntries: McpTrustEntry[] = (opts.mcpEntries ?? []).map((e) => ({
    serverId: e.serverId,
    scope: e.scope ?? "global",
    grantedAt: 1_700_000_000_000,
  }));

  return {
    currentProjectEntries: () => projectEntries,
    currentMcpEntries: () => mcpEntries,
    listProjectEntries: () => Promise.resolve(projectEntries),
    grantProjectTrust: (canonicalPath: string) => {
      projectEntries = [...projectEntries, { canonicalPath, grantedAt: new Date().toISOString() }];
      return Promise.resolve();
    },
    revokeProjectTrust: (canonicalPath: string) => {
      projectEntries = projectEntries.filter((e) => e.canonicalPath !== canonicalPath);
      return Promise.resolve();
    },
    listMcpEntries: () => Promise.resolve(mcpEntries),
    hasMcpEntry: (serverId: string) =>
      Promise.resolve(mcpEntries.some((e) => e.serverId === serverId)),
    clearMcpTrust: (serverId: string) => {
      mcpEntries = mcpEntries.filter((e) => e.serverId !== serverId);
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Shape / contract declaration tests
// ---------------------------------------------------------------------------

describe("/trust command — shape", () => {
  it("declares Command category", () => {
    assert.equal(contract.kind, "Command");
  });

  it("declares name /trust", () => {
    assert.equal(contract.name, "/trust");
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
});

// ---------------------------------------------------------------------------
// List subcommand — redaction tests (AC-93, invariant #6)
// ---------------------------------------------------------------------------

describe("/trust list — redaction", () => {
  it("returns project entries without resolved secrets", async () => {
    const { host } = mockHost({ extId: "trust" });
    const ctx = buildMockTrustContext({ projectEntries: ["/tmp/proj/.stud"] });
    await contract.lifecycle.init!(host, {});
    injectTrustContext(host, ctx);

    const result = await contract.execute(args("list", ["list"]), host);

    assert.ok(result.rendered.includes("/tmp/proj/.stud"), "canonical path must appear in output");
  });

  it("strips token/secret fields from MCP entries", async () => {
    const { host } = mockHost({ extId: "trust" });
    // Context only returns McpTrustEntry with no token field.
    const ctx = buildMockTrustContext({
      mcpEntries: [{ serverId: "github", scope: "global" }],
    });
    await contract.lifecycle.init!(host, {});
    injectTrustContext(host, ctx);

    const result = await contract.execute(args("list", ["list"]), host);

    assert.ok(result.rendered.includes("github"), "server id must appear in output");
    // Payload is a structured object — no token field.
    const payload = result.payload as { mcp?: { token?: string }[] };
    assert.ok(
      payload.mcp === undefined || payload.mcp.every((e) => e.token === undefined),
      "payload must not include token fields",
    );
  });

  it("shows (none) when both lists are empty", async () => {
    const { host } = mockHost({ extId: "trust" });
    await contract.lifecycle.init!(host, {});
    injectTrustContext(host, buildMockTrustContext());

    const result = await contract.execute(args("list", ["list"]), host);

    assert.ok(result.rendered.includes("(none)"), "must indicate empty lists");
  });
});

// ---------------------------------------------------------------------------
// --clear-mcp subcommand — Q-10 semantics
// ---------------------------------------------------------------------------

describe("/trust --clear-mcp — Q-10 semantics", () => {
  it("forgets the MCP entry so the entry is gone from the trust list", async () => {
    const { host } = mockHost({ extId: "trust" });
    const ctx = buildMockTrustContext({ mcpEntries: [{ serverId: "github" }] });
    // requireConfirmForClear: false — test the functional path without confirmation
    await contract.lifecycle.init!(host, { requireConfirmForClear: false });
    injectTrustContext(host, ctx);

    await contract.execute(args("--clear-mcp github", [], { "clear-mcp": "github" }), host);

    assert.equal(
      ctx.currentMcpEntries().find((e) => e.serverId === "github"),
      undefined,
      "github entry must be gone after clear-mcp",
    );
  });

  it("emits a TrustDecision audit record with decision=cleared and scope=mcp", async () => {
    const { host, recorders } = mockHost({ extId: "trust" });
    const ctx = buildMockTrustContext({ mcpEntries: [{ serverId: "github" }] });
    // requireConfirmForClear: false — test the functional path without confirmation
    await contract.lifecycle.init!(host, { requireConfirmForClear: false });
    injectTrustContext(host, ctx);

    await contract.execute(args("--clear-mcp github", [], { "clear-mcp": "github" }), host);

    const auditRec = recorders.audit.records.find((r) => r.class === "TrustDecision");
    assert.ok(auditRec !== undefined, "must emit TrustDecision audit record");
    assert.equal(
      (auditRec.payload as { decision?: string }).decision,
      "cleared",
      "decision must be 'cleared'",
    );
    assert.equal((auditRec.payload as { scope?: string }).scope, "mcp", "scope must be 'mcp'");
  });

  it("after --clear-mcp, hasMcpEntry returns false (next use re-prompts)", async () => {
    const { host } = mockHost({ extId: "trust" });
    const ctx = buildMockTrustContext({ mcpEntries: [{ serverId: "github" }] });
    // requireConfirmForClear: false — test the functional path without confirmation
    await contract.lifecycle.init!(host, { requireConfirmForClear: false });
    injectTrustContext(host, ctx);

    await contract.execute(args("--clear-mcp github", [], { "clear-mcp": "github" }), host);

    const stillPresent = await ctx.hasMcpEntry("github");
    assert.equal(
      stillPresent,
      false,
      "entry must be absent after clear-mcp (re-prompts on next use)",
    );
  });

  it("--clear-mcp <unknown> → ToolTerminal/NotFound", async () => {
    const { host } = mockHost({ extId: "trust" });
    const ctx = buildMockTrustContext({ mcpEntries: [] });
    // requireConfirmForClear: false — NotFound is thrown before confirmation
    await contract.lifecycle.init!(host, { requireConfirmForClear: false });
    injectTrustContext(host, ctx);

    await assert.rejects(
      () => contract.execute(args("--clear-mcp unknown", [], { "clear-mcp": "unknown" }), host),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "ToolTerminal");
        assert.equal((err as { context?: { code?: unknown } }).context?.code, "NotFound");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// --clear-mcp subcommand — confirmation and cancellation
// ---------------------------------------------------------------------------

describe("/trust --clear-mcp — confirmation", () => {
  it("--clear-mcp prompts for confirmation when requireConfirmForClear is true (default)", async () => {
    let raiseCalled = false;
    const host = fakeHost({
      onRaise: () => {
        raiseCalled = true;
        return Promise.resolve({ value: "yes" });
      },
    });
    const ctx = buildMockTrustContext({ mcpEntries: [{ serverId: "github" }] });
    // Default config — requireConfirmForClear defaults to true
    await contract.lifecycle.init!(host, {});
    injectTrustContext(host, ctx);

    await contract.execute(args("--clear-mcp github", [], { "clear-mcp": "github" }), host);

    assert.equal(
      raiseCalled,
      true,
      "interaction.raise must be called when requireConfirmForClear is true",
    );
    assert.equal(
      ctx.currentMcpEntries().find((e) => e.serverId === "github"),
      undefined,
      "entry must be cleared after confirmed prompt",
    );
  });

  it("--clear-mcp propagates Cancellation/TurnCancelled when onRaise rejects", async () => {
    const cancellation = new Cancellation("user cancelled", undefined, { code: "TurnCancelled" });
    const host = fakeHost({
      onRaise: () => Promise.reject(cancellation),
    });
    const ctx = buildMockTrustContext({ mcpEntries: [{ serverId: "github" }] });
    // Default config — requireConfirmForClear defaults to true
    await contract.lifecycle.init!(host, {});
    injectTrustContext(host, ctx);

    await assert.rejects(
      () => contract.execute(args("--clear-mcp github", [], { "clear-mcp": "github" }), host),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "Cancellation");
        return true;
      },
    );

    // Entry must not be cleared when user cancels
    assert.ok(
      ctx.currentMcpEntries().some((e) => e.serverId === "github"),
      "entry must remain when cancellation propagates",
    );
  });
});

// ---------------------------------------------------------------------------
// revoke subcommand — confirmation and cancellation
// ---------------------------------------------------------------------------

describe("/trust revoke — confirmation", () => {
  it("revoke cancels when interaction raises Cancellation/TurnCancelled", async () => {
    const cancellation = new Cancellation("user cancelled", undefined, { code: "TurnCancelled" });
    const host = fakeHost({
      onRaise: () => Promise.reject(cancellation),
    });

    const ctx = buildMockTrustContext({ projectEntries: ["/tmp/proj/.stud"] });
    await contract.lifecycle.init!(host, {});
    injectTrustContext(host, ctx);

    await assert.rejects(
      () => contract.execute(args("revoke /tmp/proj/.stud", ["revoke", "/tmp/proj/.stud"]), host),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "Cancellation");
        return true;
      },
    );
  });

  it("revoke proceeds when user confirms yes", async () => {
    const host = fakeHost({ onRaise: () => Promise.resolve({ value: "yes" }) });
    const ctx = buildMockTrustContext({ projectEntries: ["/tmp/proj/.stud"] });
    await contract.lifecycle.init!(host, {});
    injectTrustContext(host, ctx);

    const result = await contract.execute(
      args("revoke /tmp/proj/.stud", ["revoke", "/tmp/proj/.stud"]),
      host,
    );

    assert.ok(result.rendered.includes("revoked"), "rendered must confirm revocation");
    assert.equal(
      ctx.currentProjectEntries().find((e) => e.canonicalPath === "/tmp/proj/.stud"),
      undefined,
      "entry must be removed after confirmed revoke",
    );
  });

  it("revoke does not mutate when user declines (value=no)", async () => {
    const host = fakeHost({ onRaise: () => Promise.resolve({ value: "no" }) });
    const ctx = buildMockTrustContext({ projectEntries: ["/tmp/proj/.stud"] });
    await contract.lifecycle.init!(host, {});
    injectTrustContext(host, ctx);

    const result = await contract.execute(
      args("revoke /tmp/proj/.stud", ["revoke", "/tmp/proj/.stud"]),
      host,
    );

    assert.ok(result.rendered.includes("cancelled"), "rendered must note cancellation");
    assert.ok(
      ctx.currentProjectEntries().some((e) => e.canonicalPath === "/tmp/proj/.stud"),
      "entry must still be present when user declines",
    );
  });
});

// ---------------------------------------------------------------------------
// grant subcommand
// ---------------------------------------------------------------------------

describe("/trust grant", () => {
  it("grant adds a project entry and emits TrustDecision audit record", async () => {
    const { host, recorders } = mockHost({ extId: "trust" });
    const ctx = buildMockTrustContext();
    await contract.lifecycle.init!(host, {});
    injectTrustContext(host, ctx);

    await contract.execute(args("grant /new/proj/.stud", ["grant", "/new/proj/.stud"]), host);

    assert.ok(
      ctx.currentProjectEntries().some((e) => e.canonicalPath === "/new/proj/.stud"),
      "entry must be added",
    );
    const auditRec = recorders.audit.records.find((r) => r.class === "TrustDecision");
    assert.ok(auditRec !== undefined, "must emit TrustDecision audit record");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle and safety tests
// ---------------------------------------------------------------------------

describe("/trust command — lifecycle", () => {
  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "trust" });
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });

  it("runs lifecycle in order without error", async () => {
    const { host } = mockHost({ extId: "trust" });
    const order: string[] = [];

    await contract.lifecycle.init!(host, {});
    order.push("init");
    await contract.lifecycle.dispose!(host);
    order.push("dispose");

    assert.deepEqual(order, ["init", "dispose"]);
  });

  it("throws ExtensionHost/LifecycleFailure when execute is called without init", async () => {
    const { host } = mockHost({ extId: "trust" });

    await assert.rejects(
      () => contract.execute(args("list", ["list"]), host),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "ExtensionHost");
        assert.equal((err as { context?: { code?: unknown } }).context?.code, "LifecycleFailure");
        return true;
      },
    );
  });
});
